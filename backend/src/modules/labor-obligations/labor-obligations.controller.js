const { z }     = require('zod');
const { query } = require('../../config/db');
const AppError  = require('../../utils/AppError');
const { success, paginated } = require('../../utils/response');
const { newId }   = require('../../utils/id');

/* ─────────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────────── */

const fetchCatalog = () =>
  query(`SELECT * FROM obligation_catalog WHERE is_active = TRUE ORDER BY display_order, name`, []);

const buildObligations = (catalog, rawObligations, baseSalary) => {
  const oblMap = {};
  rawObligations.forEach(ov => { oblMap[ov.obligation_id] = ov; });

  // Pre-calcular fondo de reserva mensualizado para usarlo como base del Décimo Tercero.
  // Si el empleado tiene Fondo de Reserva activo y en modalidad MONTHLY, se suma al total ganado.
  const fondosCat       = catalog.find(c => c.code === 'FONDO_RESERVA');
  const fondosObl       = fondosCat ? oblMap[fondosCat.id] : null;
  const fondosIsMonthly = !!(fondosCat && fondosObl?.is_active && fondosObl?.payout_mode === 'MONTHLY');
  const fondosRate      = fondosIsMonthly
    ? parseFloat(fondosObl?.override_value ?? fondosCat?.default_value ?? 0)
    : 0;
  const fondosMonthly   = fondosIsMonthly
    ? Math.round(parseFloat(baseSalary) * fondosRate * 100) / 100
    : 0;

  // Total ganado al mes = sueldo base + fondo de reserva (si es mensualizado)
  const totalEarned = parseFloat(baseSalary) + fondosMonthly;

  return catalog.map(cat => {
    const empObl        = oblMap[cat.id];
    const isActive      = empObl?.is_active ?? false;
    const overrideValue = empObl?.override_value ?? null;

    // Décimo Tercero usa total ganado como base (incluye fondo de reserva si es mensual)
    const calcBase = cat.code === 'DECIMO_TERCERO' ? totalEarned : parseFloat(baseSalary);

    let effectiveValue = 0;
    if (isActive) {
      if (cat.calc_type === 'PERCENTAGE') {
        effectiveValue = Math.round(calcBase * parseFloat(overrideValue ?? cat.default_value ?? 0) * 100) / 100;
      } else {
        effectiveValue = Math.round(parseFloat(overrideValue ?? 0) * 100) / 100;
      }
    }

    return {
      obligation_id:   cat.id,
      code:            cat.code,
      name:            cat.name,
      description:     cat.description,
      calc_type:       cat.calc_type,
      default_value:   cat.default_value,
      payer:           cat.payer,
      recipient:       cat.recipient,
      is_system:       cat.is_system,
      is_active:       isActive,
      override_value:  overrideValue,
      payout_mode:     empObl?.payout_mode    ?? null,
      prefer_monthly:  empObl?.prefer_monthly ?? false,
      notes:           empObl?.notes          ?? null,
      effective_value: effectiveValue,
    };
  });
};

/* ─────────────────────────────────────────────────────────────────
   GET /labor-obligations  — lista global de empleados
   ───────────────────────────────────────────────────────────────── */
const listAll = async (req, res) => {
  const page   = parseInt(req.query.page  || '1',  10);
  const limit  = parseInt(req.query.limit || '50', 10);
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : null;

  const conditions = [`e.status != 'INACTIVE'`];
  const params     = [];
  let idx = 1;

  if (search) {
    conditions.push(`(e.first_name ILIKE $${idx} OR e.last_name ILIKE $${idx} OR e.cedula ILIKE $${idx})`);
    params.push(search); idx++;
  }
  const where = conditions.join(' AND ');

  const [countRes, catalogRes] = await Promise.all([
    query(`SELECT COUNT(*) FROM employees e WHERE ${where}`, params),
    fetchCatalog(),
  ]);
  const catalog = catalogRes.rows;

  const dataRes = await query(
    `SELECT
       e.id, e.first_name, e.last_name, e.cedula, e.position,
       e.base_salary, e.status, e.iess_affiliate,
       d.name AS department_name,
       COALESCE(
         json_agg(
           json_build_object(
             'obligation_id', eo.obligation_id,
             'is_active',     eo.is_active,
             'override_value',eo.override_value,
             'payout_mode',   eo.payout_mode,
             'prefer_monthly',eo.prefer_monthly,
             'notes',         eo.notes
           )
         ) FILTER (WHERE eo.obligation_id IS NOT NULL),
         '[]'::json
       ) AS raw_obligations
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employee_obligations eo ON eo.employee_id = e.id
     WHERE ${where}
     GROUP BY e.id, d.name
     ORDER BY e.last_name, e.first_name
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  const rows = dataRes.rows.map(emp => {
    const obligations      = buildObligations(catalog, emp.raw_obligations || [], emp.base_salary);
    const totalIessMonthly = Math.round(obligations.reduce((sum, o) => sum + o.effective_value, 0) * 100) / 100;

    const quiroObl  = obligations.find(o => o.code === 'IESS_QUIROGRAFARIO');
    const hipoObl   = obligations.find(o => o.code === 'IESS_HIPOTECARIO');
    const fondosObl = obligations.find(o => o.code === 'FONDO_RESERVA');

    return {
      id: emp.id,
      first_name: emp.first_name,
      last_name:  emp.last_name,
      cedula:     emp.cedula,
      position:   emp.position,
      base_salary:    emp.base_salary,
      status:         emp.status,
      iess_affiliate: emp.iess_affiliate,
      department_name: emp.department_name,
      obligations,
      iess_quirografario:    quiroObl?.effective_value  ?? 0,
      iess_hipotecario:      hipoObl?.effective_value   ?? 0,
      fondos_reserva_aplica: fondosObl?.is_active       ?? false,
      total_iess_monthly:    totalIessMonthly,
    };
  });

  paginated(res, rows, parseInt(countRes.rows[0].count, 10), page, limit);
};

/* ─────────────────────────────────────────────────────────────────
   GET /employees/:id/labor-obligations
   ───────────────────────────────────────────────────────────────── */
const getByEmployee = async (req, res) => {
  const empRes = await query('SELECT id, base_salary FROM employees WHERE id = $1', [req.params.id]);
  if (!empRes.rows[0]) throw new AppError('Empleado no encontrado', 404);
  const { id: employeeId, base_salary } = empRes.rows[0];

  const [catalogRes, eoRes] = await Promise.all([
    fetchCatalog(),
    query(`SELECT * FROM employee_obligations WHERE employee_id = $1`, [employeeId]),
  ]);

  const obligations = buildObligations(catalogRes.rows, eoRes.rows, base_salary);
  const quiroObl    = obligations.find(o => o.code === 'IESS_QUIROGRAFARIO');
  const hipoObl     = obligations.find(o => o.code === 'IESS_HIPOTECARIO');
  const fondosObl   = obligations.find(o => o.code === 'FONDO_RESERVA');

  success(res, {
    employee_id:          employeeId,
    obligations,
    fondos_reserva_aplica: fondosObl?.is_active       ?? false,
    iess_quirografario:    quiroObl?.effective_value   ?? 0,
    iess_hipotecario:      hipoObl?.effective_value    ?? 0,
    notes: null,
  });
};

/* ─────────────────────────────────────────────────────────────────
   PUT /employees/:id/labor-obligations  (upsert)
   Accepts new format ({ obligations: [...] }) and legacy format.
   ───────────────────────────────────────────────────────────────── */
const upsert = async (req, res) => {
  const empCheck = await query('SELECT id, base_salary FROM employees WHERE id = $1', [req.params.id]);
  if (!empCheck.rows[0]) throw new AppError('Empleado no encontrado', 404);
  const { id: employeeId, base_salary } = empCheck.rows[0];

  if (Array.isArray(req.body.obligations)) {
    const itemSchema = z.object({
      obligation_id:  z.string().uuid(),
      is_active:      z.boolean(),
      override_value: z.number().min(0).nullable().optional(),
      payout_mode:    z.enum(['IESS', 'EMPLOYEE', 'MONTHLY']).nullable().optional(),
      prefer_monthly: z.boolean().optional(),
      notes:          z.string().nullable().optional(),
    });
    const items = z.array(itemSchema).parse(req.body.obligations);

    for (const item of items) {
      const catCheck = await query(
        'SELECT id FROM obligation_catalog WHERE id = $1 AND is_active = TRUE', [item.obligation_id]
      );
      if (!catCheck.rows[0]) throw new AppError(`Obligación ${item.obligation_id} no encontrada en el catálogo`, 404);

      await query(
        `INSERT INTO employee_obligations
           (id, employee_id, obligation_id, is_active, override_value, payout_mode, prefer_monthly, notes,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (employee_id, obligation_id) DO UPDATE SET
           is_active      = EXCLUDED.is_active,
           override_value = EXCLUDED.override_value,
           payout_mode    = EXCLUDED.payout_mode,
           prefer_monthly = EXCLUDED.prefer_monthly,
           notes          = EXCLUDED.notes,
           updated_by     = EXCLUDED.updated_by`,
        [
          newId(), employeeId, item.obligation_id,
          item.is_active,
          item.override_value ?? null,
          item.payout_mode    ?? null,
          item.prefer_monthly ?? false,
          item.notes          ?? null,
          req.user.id,
        ]
      );
    }
  } else {
    // Legacy format
    const legacySchema = z.object({
      fondosReservaAplica: z.boolean().optional(),
      iessQuirofario:      z.number().min(0).optional(),
      iessHipotecario:     z.number().min(0).optional(),
      notes:               z.string().optional().nullable(),
    });
    const data = legacySchema.parse(req.body);

    const FONDO_ID = 'a0000003-0000-0000-0000-000000000003';
    const QUIRO_ID = 'a0000004-0000-0000-0000-000000000004';
    const HIPO_ID  = 'a0000005-0000-0000-0000-000000000005';

    if (data.fondosReservaAplica !== undefined) {
      await query(
        `INSERT INTO employee_obligations
           (id, employee_id, obligation_id, is_active, payout_mode, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'IESS', $5, $5)
         ON CONFLICT (employee_id, obligation_id) DO UPDATE SET
           is_active = EXCLUDED.is_active,
           updated_by = EXCLUDED.updated_by`,
        [newId(), employeeId, FONDO_ID, data.fondosReservaAplica, req.user.id]
      );
    }
    if (data.iessQuirofario !== undefined) {
      await query(
        `INSERT INTO employee_obligations
           (id, employee_id, obligation_id, is_active, override_value, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (employee_id, obligation_id) DO UPDATE SET
           is_active = EXCLUDED.is_active,
           override_value = EXCLUDED.override_value,
           updated_by = EXCLUDED.updated_by`,
        [newId(), employeeId, QUIRO_ID, data.iessQuirofario > 0, data.iessQuirofario > 0 ? data.iessQuirofario : null, req.user.id]
      );
    }
    if (data.iessHipotecario !== undefined) {
      await query(
        `INSERT INTO employee_obligations
           (id, employee_id, obligation_id, is_active, override_value, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (employee_id, obligation_id) DO UPDATE SET
           is_active = EXCLUDED.is_active,
           override_value = EXCLUDED.override_value,
           updated_by = EXCLUDED.updated_by`,
        [newId(), employeeId, HIPO_ID, data.iessHipotecario > 0, data.iessHipotecario > 0 ? data.iessHipotecario : null, req.user.id]
      );
    }
  }

  const [catalogRes, eoRes] = await Promise.all([
    fetchCatalog(),
    query(`SELECT * FROM employee_obligations WHERE employee_id = $1`, [employeeId]),
  ]);
  const obligations = buildObligations(catalogRes.rows, eoRes.rows, base_salary);
  const quiroObl    = obligations.find(o => o.code === 'IESS_QUIROGRAFARIO');
  const hipoObl     = obligations.find(o => o.code === 'IESS_HIPOTECARIO');
  const fondosObl   = obligations.find(o => o.code === 'FONDO_RESERVA');

  success(res, {
    employee_id:          employeeId,
    obligations,
    fondos_reserva_aplica: fondosObl?.is_active       ?? false,
    iess_quirografario:    quiroObl?.effective_value   ?? 0,
    iess_hipotecario:      hipoObl?.effective_value    ?? 0,
    notes: null,
  }, 200, 'Obligaciones actualizadas');
};

/* ─────────────────────────────────────────────────────────────────
   GET /labor-obligations/payment-records
   Historial de pagos mensuales de obligaciones por nómina
   ───────────────────────────────────────────────────────────────── */
const listPaymentRecords = async (req, res) => {
  const page       = parseInt(req.query.page       || '1',  10);
  const limit      = parseInt(req.query.limit      || '50', 10);
  const offset     = (page - 1) * limit;
  const employeeId = req.query.employeeId || null;

  const conditions = [];
  const params     = [];
  let idx = 1;

  if (employeeId) {
    conditions.push(`opr.employee_id = $${idx++}`);
    params.push(employeeId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await query(
    `SELECT COUNT(*) FROM obligation_payment_records opr ${where}`,
    params
  );

  const dataRes = await query(
    `SELECT
       opr.*,
       e.first_name, e.last_name, e.cedula,
       oc.name AS obligation_name, oc.code AS obligation_code
     FROM obligation_payment_records opr
     JOIN employees e  ON e.id  = opr.employee_id
     JOIN obligation_catalog oc ON oc.id = opr.obligation_id
     ${where}
     ORDER BY opr.period_year DESC, opr.period_month DESC, e.last_name, e.first_name
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  paginated(res, dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit);
};

module.exports = { listAll, getByEmployee, upsert, listPaymentRecords };
