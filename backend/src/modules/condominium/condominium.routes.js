const { Router } = require('express');
const { z }      = require('zod');
const multer     = require('multer');
const XLSX       = require('xlsx');
const { query, getClient } = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { uploadSingle } = require('../../services/upload.service');
const { uploadToCloudinary, deleteFromCloudinary } = require('../../services/cloudinary.service');
const { sendAliquotEmail }   = require('../../services/email.service');
const { generateAliquotPdf } = require('../../services/pdf.service');
const { newId }  = require('../../utils/id');

// Multer en memoria solo para la importación de Excel (sin Cloudinary)
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = /spreadsheetml|excel|openxmlformats|xls/.test(file.mimetype) ||
               /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new AppError('Solo se aceptan archivos .xlsx o .xls', 400), ok);
  },
}).single('file');

const router = Router();
router.use(authenticate);

// Columnas camelCase reutilizables en todos los SELECT / RETURNING de propietarios
const OWNER_COLS = `
  id,
  name              AS "fullName",
  email,
  phone,
  unit_number       AS "apartmentNumber",
  participation_pct::float AS "participationPct",
  mora_amount::float       AS "moraAmount",
  is_active         AS "isActive",
  created_at        AS "createdAt"
`;

// ── Config ────────────────────────────────────────────────────

// GET /condominium/config
router.get('/config', async (_req, res) => {
  const { rows } = await query('SELECT * FROM condo_config LIMIT 1');
  success(res, rows[0] || null);
});

// PUT /condominium/config
router.put('/config', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    name:             z.string().optional(),
    adminEmail:       z.string().email().optional(),
    fixedMaintenance: z.number().min(0).optional(),
    fixedSecurity:    z.number().min(0).optional(),
    fixedCleaning:    z.number().min(0).optional(),
    fixedOther:       z.number().min(0).optional(),
    moraEnabled:      z.boolean().optional(),
    moraRate:         z.number().min(0).max(1).optional(),
    moraGraceDays:    z.number().int().min(0).optional(),
  }).parse(req.body);

  const existing = await query('SELECT id FROM condo_config LIMIT 1');

  if (!existing.rows[0]) {
    const { rows } = await query(
      `INSERT INTO condo_config
         (id, name, admin_email, fixed_maintenance, fixed_security, fixed_cleaning, fixed_other,
          mora_enabled, mora_rate, mora_grace_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        newId(),
        data.name || 'Condominio',
        data.adminEmail || null,
        data.fixedMaintenance || 0,
        data.fixedSecurity    || 0,
        data.fixedCleaning    || 0,
        data.fixedOther       || 0,
        data.moraEnabled      ?? true,
        data.moraRate         || 0.02,
        data.moraGraceDays    || 5,
      ]
    );
    return success(res, rows[0], 201);
  }

  const { rows } = await query(
    `UPDATE condo_config SET
       name              = COALESCE($1, name),
       admin_email       = COALESCE($2, admin_email),
       fixed_maintenance = COALESCE($3, fixed_maintenance),
       fixed_security    = COALESCE($4, fixed_security),
       fixed_cleaning    = COALESCE($5, fixed_cleaning),
       fixed_other       = COALESCE($6, fixed_other),
       mora_enabled      = COALESCE($7, mora_enabled),
       mora_rate         = COALESCE($8, mora_rate),
       mora_grace_days   = COALESCE($9, mora_grace_days)
     WHERE id = $10 RETURNING *`,
    [
      data.name || null, data.adminEmail || null,
      data.fixedMaintenance ?? null, data.fixedSecurity ?? null,
      data.fixedCleaning    ?? null, data.fixedOther    ?? null,
      data.moraEnabled      ?? null, data.moraRate      ?? null,
      data.moraGraceDays    ?? null,
      existing.rows[0].id,
    ]
  );
  success(res, rows[0]);
});

// ── Propietarios ──────────────────────────────────────────────

// GET /condominium/owners
router.get('/owners', async (_req, res) => {
  const { rows } = await query(
    `SELECT ${OWNER_COLS} FROM condo_owners ORDER BY unit_number`
  );
  const totalParticipationPct = Math.round(
    rows.reduce((s, o) => s + (o.participationPct || 0), 0) * 100
  ) / 100;
  success(res, { owners: rows, totalParticipationPct });
});

// POST /condominium/owners
router.post('/owners', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    fullName:         z.string().min(2),
    email:            z.string().email().optional(),
    phone:            z.string().optional(),
    apartmentNumber:  z.string().min(1),
    participationPct: z.number().min(0).max(100),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO condo_owners (id, name, email, phone, unit_number, participation_pct)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING ${OWNER_COLS}`,
    [newId(), data.fullName, data.email || null, data.phone || null, data.apartmentNumber, data.participationPct]
  );
  success(res, rows[0], 201);
});

// POST /condominium/owners/import — carga masiva desde Excel
router.post('/owners/import', authorize('ADMIN'), (req, res, next) => {
  uploadExcel(req, res, (err) => {
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  if (!req.file) throw new AppError('Archivo requerido', 400);

  const wb       = XLSX.read(req.file.buffer, { type: 'buffer', cellFormula: false, cellNF: false });
  const ws       = wb.Sheets[wb.SheetNames[0]];
  const allRows  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  // Detectar la fila de cabeceras buscando "DPTO" + "NOMBRE"
  let dataStart = 3; // fallback para el formato conocido
  for (let i = 0; i < Math.min(allRows.length, 10); i++) {
    const c0 = String(allRows[i][0] ?? '').toUpperCase();
    const c1 = String(allRows[i][1] ?? '').toUpperCase();
    if (c0.includes('DPTO') && c1.includes('NOMBRE')) { dataStart = i + 1; break; }
  }

  let inserted = 0, updated = 0;
  const errors = [];

  for (let i = dataStart; i < allRows.length; i++) {
    const row  = allRows[i];
    const raw0 = row[0], raw1 = row[1], raw2 = row[2];

    // Fila vacía → fin del bloque de datos
    if (raw0 === null && raw1 === null) continue;

    const unitNumber = raw0 !== null ? String(raw0).trim() : null;
    const name       = raw1 !== null ? String(raw1).trim() : null;
    const pct        = raw2 !== null ? parseFloat(raw2) : NaN;

    if (!unitNumber || !name || isNaN(pct) || pct <= 0) {
      errors.push({ row: i + 1, unit: unitNumber ?? '—', reason: 'Datos incompletos o inválidos' });
      continue;
    }

    const existing = await query(
      'SELECT id FROM condo_owners WHERE unit_number = $1',
      [unitNumber]
    );

    if (existing.rows.length) {
      await query(
        `UPDATE condo_owners
            SET name = $1, participation_pct = $2
          WHERE unit_number = $3`,
        [name, pct, unitNumber]
      );
      updated++;
    } else {
      await query(
        `INSERT INTO condo_owners (id, name, unit_number, participation_pct)
         VALUES ($1, $2, $3, $4)`,
        [newId(), name, unitNumber, pct]
      );
      inserted++;
    }
  }

  success(
    res,
    { inserted, updated, errors },
    200,
    `Importación completada: ${inserted} nuevos, ${updated} actualizados${errors.length ? `, ${errors.length} errores` : ''}`
  );
});

// PUT /condominium/owners/:id  (y PATCH alias — el service llama PATCH)
const updateOwnerHandler = async (req, res) => {
  const data = z.object({
    fullName:         z.string().min(2).optional(),
    email:            z.string().email().optional().nullable(),
    phone:            z.string().optional().nullable(),
    apartmentNumber:  z.string().min(1).optional(),
    participationPct: z.number().min(0).max(100).optional(),
    isActive:         z.boolean().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE condo_owners SET
       name              = COALESCE($1, name),
       email             = COALESCE($2, email),
       phone             = COALESCE($3, phone),
       unit_number       = COALESCE($4, unit_number),
       participation_pct = COALESCE($5, participation_pct),
       is_active         = COALESCE($6, is_active)
     WHERE id = $7
     RETURNING ${OWNER_COLS}`,
    [
      data.fullName || null, data.email ?? null, data.phone ?? null,
      data.apartmentNumber || null, data.participationPct ?? null,
      data.isActive ?? null, req.params.id,
    ]
  );
  if (!rows[0]) throw new AppError('Propietario no encontrado', 404);
  success(res, rows[0]);
};
router.put('/owners/:id',   authorize('ADMIN'), updateOwnerHandler);
router.patch('/owners/:id', authorize('ADMIN'), updateOwnerHandler);

// PATCH /condominium/owners/:id/toggle — invertir is_active
router.patch('/owners/:id/toggle', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    `UPDATE condo_owners SET is_active = NOT is_active
     WHERE id = $1
     RETURNING ${OWNER_COLS}`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Propietario no encontrado', 404);
  success(res, rows[0]);
});

// DELETE /condominium/owners/:id
router.delete('/owners/:id', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    'DELETE FROM condo_owners WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Propietario no encontrado', 404);
  success(res, null, 200, 'Propietario eliminado');
});

// PATCH /condominium/owners/:id/mora — ajuste manual de mora
router.patch('/owners/:id/mora', authorize('ADMIN'), async (req, res) => {
  const { amount, operation, notes } = z.object({
    amount:    z.number(),
    operation: z.enum(['ADD', 'SUBTRACT', 'SET']).default('ADD'),
    notes:     z.string().optional(),
  }).parse(req.body);

  const moraSql =
    operation === 'SET'      ? '$1' :
    operation === 'ADD'      ? 'mora_amount + $1' :
                               'GREATEST(0, mora_amount - $1)';

  const { rows } = await query(
    `UPDATE condo_owners SET mora_amount = ${moraSql}
     WHERE id = $2
     RETURNING ${OWNER_COLS}`,
    [amount, req.params.id]
  );
  if (!rows[0]) throw new AppError('Propietario no encontrado', 404);
  success(res, rows[0], 200, `Mora ajustada (${operation} ${amount})`);
});

// ── Períodos ──────────────────────────────────────────────────

// GET /condominium/periods
router.get('/periods', async (_req, res) => {
  const { rows } = await query(
    `SELECT cep.*,
            COUNT(ap.id)::int     AS total_payments,
            SUM(CASE WHEN ap.status = 'PAID' THEN 1 ELSE 0 END)::int AS paid_count,
            COALESCE(SUM(ap.paid_amount), 0) AS total_collected
     FROM condo_expense_periods cep
     LEFT JOIN aliquot_payments ap ON ap.period_id = cep.id
     GROUP BY cep.id
     ORDER BY cep.year DESC, cep.month DESC`
  );
  success(res, rows);
});

// GET /condominium/periods/:id
router.get('/periods/:id', async (req, res) => {
  const periodRes = await query('SELECT * FROM condo_expense_periods WHERE id = $1', [req.params.id]);
  if (!periodRes.rows[0]) throw new AppError('Período no encontrado', 404);

  const paymentsRes = await query(
    `SELECT ap.*, o.name AS owner_name, o.email AS owner_email, o.unit_number
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     WHERE ap.period_id = $1
     ORDER BY o.unit_number`,
    [req.params.id]
  );

  success(res, { ...periodRes.rows[0], payments: paymentsRes.rows });
});

// POST /condominium/periods
router.post('/periods', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    month:            z.number().int().min(1).max(12),
    year:             z.number().int().min(2000),
    variableExpenses: z.number().min(0).default(0),
    notes:            z.string().optional(),
  }).parse(req.body);

  const configRes = await query('SELECT * FROM condo_config LIMIT 1');
  const cfg = configRes.rows[0];
  if (!cfg) throw new AppError('Configure el condominio primero', 400);

  const totalExpenses =
    cfg.fixed_maintenance + cfg.fixed_security + cfg.fixed_cleaning +
    cfg.fixed_other + data.variableExpenses;

  const { rows } = await query(
    `INSERT INTO condo_expense_periods
       (id, month, year, fixed_maintenance, fixed_security, fixed_cleaning, fixed_other,
        variable_expenses, total_expenses, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      newId(),
      data.month, data.year,
      cfg.fixed_maintenance, cfg.fixed_security, cfg.fixed_cleaning, cfg.fixed_other,
      data.variableExpenses, totalExpenses, data.notes || null, req.user.id,
    ]
  );
  success(res, rows[0], 201);
});

// POST /condominium/periods/:id/generate — generar alícuotas
router.post('/periods/:id/generate', authorize('ADMIN'), async (req, res) => {
  const periodRes = await query('SELECT * FROM condo_expense_periods WHERE id = $1', [req.params.id]);
  const period = periodRes.rows[0];
  if (!period) throw new AppError('Período no encontrado', 404);
  if (period.status === 'CLOSED') throw new AppError('Período cerrado', 400);

  const ownersRes = await query('SELECT * FROM condo_owners WHERE is_active = TRUE');
  const owners = ownersRes.rows;
  if (!owners.length) throw new AppError('No hay propietarios activos', 400);

  // Validar suma 100%
  const totalPct = owners.reduce((s, o) => s + parseFloat(o.participation_pct), 0);
  if (Math.abs(totalPct - 100) > 0.01) {
    throw new AppError(`Suma de porcentajes es ${totalPct.toFixed(4)}% — debe ser 100%`, 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    for (const owner of owners) {
      const aliquotAmount = Math.round(
        parseFloat(period.total_expenses) * parseFloat(owner.participation_pct) / 100 * 100
      ) / 100;

      await client.query(
        `INSERT INTO aliquot_payments
           (id, period_id, owner_id, aliquot_amount, mora_at_billing)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (period_id, owner_id) DO UPDATE SET
           aliquot_amount = EXCLUDED.aliquot_amount,
           mora_at_billing = EXCLUDED.mora_at_billing`,
        [newId(), period.id, owner.id, aliquotAmount, owner.mora_amount]
      );
    }

    await client.query(
      `UPDATE condo_expense_periods SET status = 'APPROVED', generated_at = NOW() WHERE id = $1`,
      [period.id]
    );

    await client.query('COMMIT');
    success(res, null, 200, `Alícuotas generadas para ${owners.length} propietarios`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /condominium/periods/:id/send-emails — enviar correos de cobro
router.post('/periods/:id/send-emails', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    `SELECT ap.*, o.name AS owner_name, o.email AS owner_email, o.unit_number,
            cep.month, cep.year, cep.total_expenses
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE ap.period_id = $1 AND o.email IS NOT NULL
       AND ap.status IN ('PENDING', 'PARTIAL', 'OVERDUE')`,
    [req.params.id]
  );

  let sent = 0;
  for (const payment of rows) {
    await sendAliquotEmail(payment);
    sent++;
  }
  success(res, null, 200, `Emails enviados: ${sent}`);
});

// POST /condominium/periods/:id/close — cerrar período
router.post('/periods/:id/close', authorize('ADMIN'), async (req, res) => {
  const periodRes = await query('SELECT * FROM condo_expense_periods WHERE id = $1', [req.params.id]);
  const period = periodRes.rows[0];
  if (!period) throw new AppError('Período no encontrado', 404);
  if (period.status === 'CLOSED') throw new AppError('Período ya cerrado', 400);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Pagos pendientes/parciales → OVERDUE; acumular mora en propietario
    const unpaidRes = await client.query(
      `SELECT ap.*, o.mora_amount AS current_mora
       FROM aliquot_payments ap
       JOIN condo_owners o ON o.id = ap.owner_id
       WHERE ap.period_id = $1 AND ap.status IN ('PENDING', 'PARTIAL')`,
      [period.id]
    );

    for (const ap of unpaidRes.rows) {
      const pending = parseFloat(ap.aliquot_amount) + parseFloat(ap.mora_at_billing) - parseFloat(ap.paid_amount);
      await client.query(
        `UPDATE aliquot_payments SET status = 'OVERDUE' WHERE id = $1`,
        [ap.id]
      );
      await client.query(
        `UPDATE condo_owners SET mora_amount = mora_amount + $1 WHERE id = $2`,
        [pending, ap.owner_id]
      );
    }

    await client.query(
      `UPDATE condo_expense_periods SET status = 'CLOSED', closed_at = NOW() WHERE id = $1`,
      [period.id]
    );

    await client.query('COMMIT');
    success(res, null, 200, 'Período cerrado');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── Pagos de alícuota ─────────────────────────────────────────

// POST /condominium/payments/:paymentId/register
router.post('/payments/:paymentId/register', authorize('ADMIN'), async (req, res) => {
  const { paidAmount, paymentDate, notes } = z.object({
    paidAmount:  z.number().positive(),
    paymentDate: z.string(),
    notes:       z.string().optional(),
  }).parse(req.body);

  const apRes = await query('SELECT * FROM aliquot_payments WHERE id = $1', [req.params.paymentId]);
  const ap = apRes.rows[0];
  if (!ap) throw new AppError('Pago no encontrado', 404);
  if (ap.status === 'PAID') throw new AppError('Ya fue pagado en su totalidad', 400);

  const total = parseFloat(ap.aliquot_amount) + parseFloat(ap.mora_at_billing);
  const newPaid = parseFloat(ap.paid_amount) + paidAmount;
  const status  = newPaid >= total ? 'PAID' : 'PARTIAL';

  const { rows } = await query(
    `UPDATE aliquot_payments SET
       paid_amount = $1, payment_date = $2, status = $3, notes = $4, registered_by = $5
     WHERE id = $6 RETURNING *`,
    [newPaid, paymentDate, status, notes || null, req.user.id, ap.id]
  );

  // Si pagó completo y tenía mora, descontar mora al propietario
  if (status === 'PAID' && parseFloat(ap.mora_at_billing) > 0) {
    await query(
      `UPDATE condo_owners SET mora_amount = GREATEST(0, mora_amount - $1) WHERE id = $2`,
      [ap.mora_at_billing, ap.owner_id]
    );
  }

  success(res, rows[0], 200, `Pago registrado (${status})`);
});

// POST /condominium/payments/:paymentId/proof — subir comprobante
router.post('/payments/:paymentId/proof', authorize('ADMIN'), uploadSingle, async (req, res) => {
  if (!req.file) throw new AppError('Archivo requerido', 400);

  const apRes = await query('SELECT * FROM aliquot_payments WHERE id = $1', [req.params.paymentId]);
  const ap = apRes.rows[0];
  if (!ap) throw new AppError('Pago no encontrado', 404);

  // Eliminar comprobante anterior si existe
  if (ap.proof_public_id) {
    await deleteFromCloudinary(ap.proof_public_id);
  }

  const month = String(ap.created_at).slice(0, 7);
  const folder = `rrhh-admin/condominio/comprobantes/${month}`;
  const { url, publicId } = await uploadToCloudinary(req.file.buffer, folder, req.file.mimetype);

  const newStatus = ap.status === 'PENDING' ? 'PARTIAL' : ap.status;

  const { rows } = await query(
    `UPDATE aliquot_payments SET
       proof_url = $1, proof_public_id = $2, proof_uploaded_at = NOW(), status = $3
     WHERE id = $4 RETURNING *`,
    [url, publicId, newStatus, ap.id]
  );

  success(res, rows[0], 200, 'Comprobante subido');
});

// DELETE /condominium/payments/:paymentId/proof
router.delete('/payments/:paymentId/proof', authorize('ADMIN'), async (req, res) => {
  const apRes = await query(
    'SELECT proof_public_id FROM aliquot_payments WHERE id = $1',
    [req.params.paymentId]
  );
  const ap = apRes.rows[0];
  if (!ap) throw new AppError('Pago no encontrado', 404);
  if (!ap.proof_public_id) throw new AppError('No hay comprobante', 400);

  await deleteFromCloudinary(ap.proof_public_id);

  await query(
    `UPDATE aliquot_payments SET proof_url = NULL, proof_public_id = NULL, proof_uploaded_at = NULL
     WHERE id = $1`,
    [req.params.paymentId]
  );
  success(res, null, 200, 'Comprobante eliminado');
});

// GET /condominium/payments/:paymentId/pdf
router.get('/payments/:paymentId/pdf', async (req, res) => {
  const { rows } = await query(
    `SELECT ap.*, o.name AS owner_name, o.unit_number, o.email AS owner_email,
            cep.month, cep.year, cep.total_expenses
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE ap.id = $1`,
    [req.params.paymentId]
  );
  if (!rows[0]) throw new AppError('Pago no encontrado', 404);

  const pdfBuffer = await generateAliquotPdf(rows[0]);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="alicuota-${rows[0].unit_number}-${rows[0].year}-${rows[0].month}.pdf"`,
  });
  res.send(pdfBuffer);
});

// ── Morosidad ─────────────────────────────────────────────────

// GET /condominium/reports/morosidad  (alias /morosidad para compatibilidad)
const morosidadHandler = async (_req, res) => {
  const { rows } = await query(
    `SELECT
       o.id,
       o.name              AS "fullName",
       o.unit_number       AS "apartmentNumber",
       o.email,
       o.phone,
       o.mora_amount::float AS "moraAmount",
       o.is_active          AS "isActive",
       o.created_at         AS "createdAt",
       COUNT(ap.id)::int    AS "overduePeriods"
     FROM condo_owners o
     LEFT JOIN aliquot_payments ap ON ap.owner_id = o.id AND ap.status = 'OVERDUE'
     WHERE o.mora_amount > 0 OR ap.id IS NOT NULL
     GROUP BY o.id
     ORDER BY o.mora_amount DESC`
  );
  success(res, rows);
};
router.get('/morosidad',         morosidadHandler);
router.get('/reports/morosidad', morosidadHandler);

module.exports = router;
