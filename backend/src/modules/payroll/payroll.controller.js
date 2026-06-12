const { z }      = require('zod');
const { query, getClient } = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success, paginated } = require('../../utils/response');
const { calculatePayroll } = require('./payroll.calculator');
const { generatePayrollPdf } = require('../../services/pdf.service');
const { sendPayrollEmail }   = require('../../services/email.service');
const { newId }  = require('../../utils/id');

// ── Períodos ──────────────────────────────────────────────────

// GET /payroll/periods
const listPeriods = async (req, res) => {
  const page   = parseInt(req.query.page  || '1',  10);
  const limit  = parseInt(req.query.limit || '12', 10);
  const offset = (page - 1) * limit;

  const countRes = await query('SELECT COUNT(*) FROM payroll_periods');
  const dataRes  = await query(
    `SELECT pp.*,
            COUNT(pd.id)::int AS employee_count,
            SUM(pd.net_pay)   AS total_net
     FROM payroll_periods pp
     LEFT JOIN payroll_details pd ON pd.period_id = pp.id
     GROUP BY pp.id
     ORDER BY pp.year DESC, pp.month DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  paginated(res, dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit);
};

// GET /payroll/periods/:periodId
const getPeriod = async (req, res) => {
  const { rows } = await query(
    `SELECT pp.*,
            COUNT(pd.id)::int AS employee_count,
            SUM(pd.net_pay)   AS total_net
     FROM payroll_periods pp
     LEFT JOIN payroll_details pd ON pd.period_id = pp.id
     WHERE pp.id = $1
     GROUP BY pp.id`,
    [req.params.periodId]
  );
  if (!rows[0]) throw new AppError('Período no encontrado', 404);
  success(res, rows[0]);
};

// POST /payroll/periods
const createPeriod = async (req, res) => {
  const { month, year } = z.object({
    month: z.number().int().min(1).max(12),
    year:  z.number().int().min(2000),
  }).parse(req.body);

  // Solo se puede crear el período del mes en curso
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear  = now.getFullYear();
  if (month !== currentMonth || year !== currentYear) {
    throw new AppError(
      `Solo se puede crear el período del mes en curso (${currentMonth}/${currentYear})`,
      400
    );
  }

  // No se puede crear si ya existe ese período
  const existing = await query(
    'SELECT id FROM payroll_periods WHERE month = $1 AND year = $2',
    [month, year]
  );
  if (existing.rows.length) {
    throw new AppError(`Ya existe un período para ${month}/${year}`, 409);
  }

  // No se puede crear si hay un período anterior aún abierto
  const openPeriod = await query(
    `SELECT id, month, year FROM payroll_periods
     WHERE status != 'CLOSED'
     ORDER BY year ASC, month ASC
     LIMIT 1`
  );
  if (openPeriod.rows.length) {
    const { month: om, year: oy } = openPeriod.rows[0];
    throw new AppError(
      `Debe cerrar el período ${om}/${oy} antes de crear uno nuevo`,
      409
    );
  }

  const { rows } = await query(
    `INSERT INTO payroll_periods (id, month, year, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [newId(), month, year, req.user.id]
  );
  success(res, rows[0], 201, 'Período creado');
};

// ── Detalles ──────────────────────────────────────────────────

// GET /payroll/periods/:periodId/details
const listDetails = async (req, res) => {
  const { rows } = await query(
    `SELECT pd.*,
            e.first_name, e.last_name, e.cedula, e.position,
            d.name AS department_name,
            -- Desglose de pagos
            pd.net_pay AS to_employee,
            -- to_iess: fondos de reserva solo cuando el modo es IESS (no mensualizado)
            (pd.iess_employee + pd.iess_employer + pd.iess_loans
             + CASE WHEN pd.fondos_payout_mode = 'IESS' THEN pd.fondos_reserva ELSE 0 END
            ) AS to_iess,
            -- employer_cost: lo que realmente desembolsa la empresa
            -- Si fondos es MONTHLY ya está en net_pay; si es IESS se suma aparte
            (pd.net_pay + pd.iess_employer
             + CASE WHEN pd.fondos_payout_mode = 'IESS' THEN pd.fondos_reserva ELSE 0 END
            ) AS employer_cost
     FROM payroll_details pd
     JOIN employees e ON e.id = pd.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE pd.period_id = $1
     ORDER BY e.last_name, e.first_name`,
    [req.params.periodId]
  );

  const summary = rows.reduce(
    (acc, d) => ({
      total_to_employees: acc.total_to_employees + parseFloat(d.to_employee  || 0),
      total_to_iess:      acc.total_to_iess      + parseFloat(d.to_iess      || 0),
      total_employer_cost:acc.total_employer_cost+ parseFloat(d.employer_cost|| 0),
    }),
    { total_to_employees: 0, total_to_iess: 0, total_employer_cost: 0 }
  );

  // Redondear
  summary.total_to_employees  = Math.round(summary.total_to_employees  * 100) / 100;
  summary.total_to_iess       = Math.round(summary.total_to_iess       * 100) / 100;
  summary.total_employer_cost = Math.round(summary.total_employer_cost * 100) / 100;

  success(res, { items: rows, summary });
};

// POST /payroll/periods/:periodId/generate
// Genera/recalcula nómina para todos los empleados activos
const generatePayroll = async (req, res) => {
  const { periodId } = req.params;

  const periodRes = await query('SELECT * FROM payroll_periods WHERE id = $1', [periodId]);
  const period    = periodRes.rows[0];
  if (!period)               throw new AppError('Período no encontrado', 404);
  if (period.status === 'CLOSED') throw new AppError('El período ya está cerrado', 400);

  // ── Leer valores de beneficios desde el catálogo ──────────────
  const catalogRes = await query(
    `SELECT code, calc_type, default_value
     FROM obligation_catalog
     WHERE code IN ('DECIMO_TERCERO', 'DECIMO_CUARTO', 'FONDO_RESERVA') AND is_active = TRUE`
  );
  const catalogMap = {};
  catalogRes.rows.forEach(r => { catalogMap[r.code] = r; });
  const decimoTerceroRate  = parseFloat(catalogMap['DECIMO_TERCERO']?.default_value ?? 0.0833);
  const decimoCuartoAmount = parseFloat(catalogMap['DECIMO_CUARTO']?.default_value  ?? 38.33);
  const fondosReservaRate  = parseFloat(catalogMap['FONDO_RESERVA']?.default_value  ?? 0.0833);

  const empRes = await query(
    `SELECT e.*, vb.available_days,
            COALESCE(eo_fondos.is_active, FALSE)                       AS fondos_reserva_aplica,
            COALESCE(eo_fondos.payout_mode, 'MONTHLY')                 AS fondos_payout_mode,
            COALESCE(eo_quiro.override_value, 0)                       AS iess_quirografario,
            COALESCE(eo_hipo.override_value, 0)                        AS iess_hipotecario
     FROM employees e
     LEFT JOIN vacation_balances vb ON vb.employee_id = e.id
     LEFT JOIN employee_obligations eo_fondos ON eo_fondos.employee_id = e.id
       AND eo_fondos.obligation_id = 'a0000003-0000-0000-0000-000000000003'
     LEFT JOIN employee_obligations eo_quiro ON eo_quiro.employee_id = e.id
       AND eo_quiro.obligation_id = 'a0000004-0000-0000-0000-000000000004' AND eo_quiro.is_active = TRUE
     LEFT JOIN employee_obligations eo_hipo ON eo_hipo.employee_id = e.id
       AND eo_hipo.obligation_id = 'a0000005-0000-0000-0000-000000000005' AND eo_hipo.is_active = TRUE
     WHERE e.status = 'ACTIVE'`
  );

  const client = await getClient();
  try {
    await client.query('BEGIN');

    for (const emp of empRes.rows) {
      // Préstamos activos
      const loanRes = await client.query(
        `SELECT COALESCE(SUM(monthly_discount), 0) AS total
         FROM loans WHERE employee_id = $1 AND status = 'ACTIVE'`,
        [emp.id]
      );
      const loanDiscount      = parseFloat(loanRes.rows[0].total);
      const iessLoansDiscount  = parseFloat(emp.iess_quirografario || 0) + parseFloat(emp.iess_hipotecario || 0);

      const detail = calculatePayroll({
        employee:          emp,
        month:             period.month,
        year:              period.year,
        loanDiscount,
        iessLoansDiscount,
        decimoTerceroRate,
        decimoCuartoAmount,
        fondosReservaRate,
        fondosPayoutMode:  emp.fondos_payout_mode,
      });

      await client.query(
        `INSERT INTO payroll_details
           (id, period_id, employee_id, base_salary, worked_days,
            overtime_supp_hours, overtime_extr_hours, overtime_pay,
            decimo_tercero, decimo_cuarto, fondos_reserva, fondos_payout_mode,
            iess_employee, iess_employer, loan_discount, iess_loans, other_discounts,
            gross_pay, net_pay)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (period_id, employee_id) DO UPDATE SET
           base_salary = EXCLUDED.base_salary,
           worked_days = EXCLUDED.worked_days,
           overtime_pay = EXCLUDED.overtime_pay,
           decimo_tercero = EXCLUDED.decimo_tercero,
           decimo_cuarto = EXCLUDED.decimo_cuarto,
           fondos_reserva = EXCLUDED.fondos_reserva,
           fondos_payout_mode = EXCLUDED.fondos_payout_mode,
           iess_employee = EXCLUDED.iess_employee,
           iess_employer = EXCLUDED.iess_employer,
           loan_discount = EXCLUDED.loan_discount,
           iess_loans = EXCLUDED.iess_loans,
           gross_pay = EXCLUDED.gross_pay,
           net_pay = EXCLUDED.net_pay`,
        [
          newId(),
          periodId, emp.id,
          detail.baseSalary, detail.workedDays,
          detail.overtimeSuppHours, detail.overtimeExtrHours, detail.overtimePay,
          detail.decimoTercero, detail.decimoCuarto, detail.fondosReserva, detail.fondosPayoutMode,
          detail.iessEmployee, detail.iessEmployer, detail.loanDiscount, detail.iessLoansDiscount, detail.otherDiscounts,
          detail.grossPay, detail.netPay,
        ]
      );

      // ── Registrar pagos mensuales de obligaciones ──────────────
      // Se registra una cuota por cada obligación que se incluyó en esta nómina.
      // installment_num = mes del período (ej: 3 = marzo = cuota 3/12)
      const DECIMO_TERCERO_ID = 'a0000006-0000-0000-0000-000000000006';
      const DECIMO_CUARTO_ID  = 'a0000007-0000-0000-0000-000000000007';
      const FONDO_RESERVA_ID  = 'a0000003-0000-0000-0000-000000000003';

      const oblRecords = [
        { id: DECIMO_TERCERO_ID, amount: detail.decimoTercero,  include: detail.decimoTercero  > 0 },
        { id: DECIMO_CUARTO_ID,  amount: detail.decimoCuarto,   include: detail.decimoCuarto   > 0 },
        { id: FONDO_RESERVA_ID,  amount: detail.fondosReserva,  include: detail.fondosReserva  > 0 && detail.fondosPayoutMode === 'MONTHLY' },
      ];

      for (const rec of oblRecords.filter(r => r.include)) {
        await client.query(
          `INSERT INTO obligation_payment_records
             (id, employee_id, obligation_id, payroll_period_id,
              period_month, period_year, installment_num, total_installments, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (employee_id, obligation_id, payroll_period_id) DO UPDATE SET
             amount = EXCLUDED.amount, installment_num = EXCLUDED.installment_num`,
          [newId(), emp.id, rec.id, periodId,
           period.month, period.year, period.month, 12, rec.amount]
        );
      }
    }

    await client.query(
      `UPDATE payroll_periods SET status = 'APPROVED' WHERE id = $1`,
      [periodId]
    );

    await client.query('COMMIT');
    success(res, null, 200, `Nómina generada para ${empRes.rows.length} empleados`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// PUT /payroll/periods/:periodId/details/:employeeId
// Ajuste manual de horas extras / descuentos
const updateDetail = async (req, res) => {
  const { periodId, employeeId } = req.params;
  const schema = z.object({
    overtimeSuppHours: z.number().min(0).optional(),
    overtimeExtrHours: z.number().min(0).optional(),
    otherDiscounts:    z.number().min(0).optional(),
    notes:             z.string().optional(),
  });
  const data = schema.parse(req.body);

  const empRes = await query('SELECT * FROM employees WHERE id = $1', [employeeId]);
  const periodRes = await query('SELECT * FROM payroll_periods WHERE id = $1', [periodId]);
  const emp    = empRes.rows[0];
  const period = periodRes.rows[0];

  if (!emp || !period) throw new AppError('No encontrado', 404);
  if (period.status === 'CLOSED') throw new AppError('Período cerrado', 400);

  // Cargar obligaciones laborales del empleado + catálogo de beneficios
  const [eloRes, catalogRes] = await Promise.all([
    query(
      `SELECT
         COALESCE(eo_fondos.is_active, FALSE)         AS fondos_reserva_aplica,
         COALESCE(eo_fondos.payout_mode, 'MONTHLY')   AS fondos_payout_mode,
         COALESCE(eo_quiro.override_value, 0)         AS iess_quirografario,
         COALESCE(eo_hipo.override_value, 0)          AS iess_hipotecario
       FROM (SELECT $1::varchar AS eid) base
       LEFT JOIN employee_obligations eo_fondos ON eo_fondos.employee_id = base.eid
         AND eo_fondos.obligation_id = 'a0000003-0000-0000-0000-000000000003'
       LEFT JOIN employee_obligations eo_quiro ON eo_quiro.employee_id = base.eid
         AND eo_quiro.obligation_id = 'a0000004-0000-0000-0000-000000000004' AND eo_quiro.is_active = TRUE
       LEFT JOIN employee_obligations eo_hipo ON eo_hipo.employee_id = base.eid
         AND eo_hipo.obligation_id = 'a0000005-0000-0000-0000-000000000005' AND eo_hipo.is_active = TRUE`,
      [employeeId]
    ),
    query(
      `SELECT code, calc_type, default_value FROM obligation_catalog
       WHERE code IN ('DECIMO_TERCERO', 'DECIMO_CUARTO', 'FONDO_RESERVA') AND is_active = TRUE`
    ),
  ]);

  const elo = eloRes.rows[0] || { fondos_reserva_aplica: false, fondos_payout_mode: 'MONTHLY', iess_quirografario: 0, iess_hipotecario: 0 };
  const empWithObligation = { ...emp, ...elo };

  const catalogMap = {};
  catalogRes.rows.forEach(r => { catalogMap[r.code] = r; });
  const decimoTerceroRate  = parseFloat(catalogMap['DECIMO_TERCERO']?.default_value ?? 0.0833);
  const decimoCuartoAmount = parseFloat(catalogMap['DECIMO_CUARTO']?.default_value  ?? 38.33);
  const fondosReservaRate  = parseFloat(catalogMap['FONDO_RESERVA']?.default_value  ?? 0.0833);

  const loanRes = await query(
    `SELECT COALESCE(SUM(monthly_discount), 0) AS total
     FROM loans WHERE employee_id = $1 AND status = 'ACTIVE'`,
    [employeeId]
  );

  const iessLoansDiscount = parseFloat(elo.iess_quirografario || 0) + parseFloat(elo.iess_hipotecario || 0);
  const detail = calculatePayroll({
    employee:          empWithObligation,
    month:             period.month,
    year:              period.year,
    overtimeSuppHours: data.overtimeSuppHours ?? 0,
    overtimeExtrHours: data.overtimeExtrHours ?? 0,
    loanDiscount:      parseFloat(loanRes.rows[0].total),
    iessLoansDiscount,
    otherDiscounts:    data.otherDiscounts ?? 0,
    decimoTerceroRate,
    decimoCuartoAmount,
    fondosReservaRate,
    fondosPayoutMode:  elo.fondos_payout_mode,
  });

  const { rows } = await query(
    `UPDATE payroll_details SET
       overtime_supp_hours = $1, overtime_extr_hours = $2, overtime_pay = $3,
       decimo_tercero = $4, decimo_cuarto = $5, fondos_reserva = $6, fondos_payout_mode = $7,
       other_discounts = $8, gross_pay = $9, net_pay = $10, notes = $11
     WHERE period_id = $12 AND employee_id = $13
     RETURNING *`,
    [
      detail.overtimeSuppHours, detail.overtimeExtrHours, detail.overtimePay,
      detail.decimoTercero, detail.decimoCuarto, detail.fondosReserva, detail.fondosPayoutMode,
      detail.otherDiscounts, detail.grossPay, detail.netPay,
      data.notes || null, periodId, employeeId,
    ]
  );
  success(res, rows[0]);
};

// POST /payroll/periods/:periodId/close
const closePeriod = async (req, res) => {
  const { rows } = await query(
    `UPDATE payroll_periods SET status = 'CLOSED' WHERE id = $1 AND status != 'CLOSED' RETURNING *`,
    [req.params.periodId]
  );
  if (!rows[0]) throw new AppError('Período no encontrado o ya cerrado', 404);
  success(res, rows[0], 200, 'Período cerrado');
};

// GET /payroll/details/:detailId/pdf
const downloadPdf = async (req, res) => {
  const { rows } = await query(
    `SELECT pd.*, pp.month, pp.year,
            e.first_name, e.last_name, e.cedula, e.position,
            e.bank_name, e.bank_account,
            d.name AS department_name
     FROM payroll_details pd
     JOIN payroll_periods pp ON pp.id = pd.period_id
     JOIN employees e ON e.id = pd.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE pd.id = $1`,
    [req.params.detailId]
  );
  if (!rows[0]) throw new AppError('Detalle no encontrado', 404);

  const pdfBuffer = await generatePayrollPdf(rows[0]);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="rol-${rows[0].cedula}-${rows[0].year}-${rows[0].month}.pdf"`,
  });
  res.send(pdfBuffer);
};

module.exports = { listPeriods, getPeriod, createPeriod, listDetails, generatePayroll, updateDetail, closePeriod, downloadPdf };
