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
const {
  generateAliquotPdf,
  generateAliquotEmailSummaryPdf,
  generatePeriodSummaryPdf,
  generateBalancePdf,
} = require('../../services/pdf.service');
const { newId }  = require('../../utils/id');
const config     = require('../../config/config');

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

const OCR_IGNORED_NAME_WORDS = new Set(['DEL', 'DE', 'LA', 'LAS', 'LOS', 'Y', 'EL']);

function nameTokens(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(token => token.length >= 3 && !OCR_IGNORED_NAME_WORDS.has(token));
}

function findOwnerMatches(senderName, payments) {
  const senderTokens = new Set(nameTokens(senderName));
  if (!senderTokens.size) return [];
  return payments.filter(payment => nameTokens(payment.ownerName).some(token => senderTokens.has(token)));
}

function numericAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value || '').trim().replace(/[$\s]/g, '');
  if (!normalized) return null;
  const amount = normalized.includes(',') && normalized.includes('.')
    ? Number(normalized.replace(/,/g, ''))
    : Number(normalized.replace(',', '.'));
  return Number.isFinite(amount) ? amount : null;
}

function findPaymentAmountMatches(amount, payments) {
  if (!amount || amount <= 0) return [];
  return payments.filter(payment => {
    const pending = Math.max(0, Number(payment.totalDue) - Number(payment.amountPaid));
    return payment.paymentStatus !== 'PAID' && Math.abs(pending - amount) <= 0.01;
  });
}

// Un PDF de movimientos puede respaldar varios pagos. Solo se elimina del
// bucket cuando ninguna alícuota ni abono a mora conserva una referencia.
async function deleteProofIfUnreferenced(publicId) {
  if (!publicId) return;
  const { rows } = await query(
     `SELECT EXISTS (
       SELECT 1 FROM aliquot_payments WHERE proof_public_id = $1
       UNION ALL
       SELECT 1 FROM aliquot_payment_records WHERE proof_public_id = $1
       UNION ALL
       SELECT 1 FROM mora_payment_records WHERE proof_public_id = $1
     ) AS referenced`,
    [publicId]
  );
  if (!rows[0].referenced) await deleteFromCloudinary(publicId);
}

function toOcrOwnerMatch(row) {
  return {
    paymentId: row.paymentId,
    paymentStatus: row.paymentStatus,
    aliquotAmount: row.aliquotAmount,
    moraAtBilling: row.moraAtBilling,
    amountPaid: row.amountPaid,
    totalDue: row.totalDue,
    owner: {
      id: row.ownerId,
      fullName: row.ownerName,
      apartmentNumber: row.apartmentNumber,
    },
  };
}

// Aplica un abono a mora siguiendo FIFO: primero el período vencido más
// antiguo. Cada tramo queda auditado y enlazado a la alícuota que lo originó.
async function applyMoraPayment(client, {
  ownerId, amount, paymentDate, paymentType, sourceAliquotPaymentId = null,
  proofUrl = null, proofPublicId = null, notes = null, registeredBy,
}) {
  const debtsRes = await client.query(
    `SELECT ap.id, ap.aliquot_amount::float AS aliquot_amount, ap.paid_amount::float AS paid_amount,
            (ap.aliquot_amount + COALESCE((
              SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
            ), 0))::float AS period_due
     FROM aliquot_payments ap
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE ap.owner_id = $1 AND ap.status = 'OVERDUE'
     ORDER BY cep.year ASC, cep.month ASC
     FOR UPDATE OF ap`,
    [ownerId]
  );

  let remaining = amount;
  const recordIds = [];
  for (const debt of debtsRes.rows) {
    const pending = Math.max(0, debt.period_due - debt.paid_amount);
    if (pending <= 0.01 || remaining <= 0.01) continue;

    const applied = Math.min(remaining, pending);
    const newPaid = debt.paid_amount + applied;
    const debtStatus = newPaid >= debt.period_due - 0.01 ? 'PAID' : 'OVERDUE';
    await client.query(
      'UPDATE aliquot_payments SET paid_amount = $1, status = $2, payment_date = $3, updated_by = $4 WHERE id = $5',
      [newPaid, debtStatus, paymentDate, registeredBy, debt.id]
    );

    const recordId = newId();
    await client.query(
      `INSERT INTO mora_payment_records
         (id, owner_id, debt_payment_id, aliquot_payment_id, amount, payment_date, payment_type,
          proof_url, proof_public_id, notes, registered_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11)`,
      [recordId, ownerId, debt.id, sourceAliquotPaymentId,
       applied, paymentDate, paymentType, proofUrl, proofPublicId, notes, registeredBy]
    );
    recordIds.push(recordId);
    remaining -= applied;
  }

  // Puede existir mora ajustada manualmente y sin período fuente. Se conserva
  // el abono, explícitamente marcado como tal, en lugar de perder trazabilidad.
  if (remaining > 0.01) {
    const recordId = newId();
    await client.query(
      `INSERT INTO mora_payment_records
         (id, owner_id, debt_payment_id, aliquot_payment_id, amount, payment_date, payment_type,
          proof_url, proof_public_id, notes, registered_by, created_by, updated_by)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10)`,
      [recordId, ownerId, sourceAliquotPaymentId, remaining, paymentDate, paymentType,
       proofUrl, proofPublicId, [notes, 'Abono a mora sin período asociado'].filter(Boolean).join(' — '), registeredBy]
    );
    recordIds.push(recordId);
  }

  await client.query(
    'UPDATE condo_owners SET mora_amount = GREATEST(0, mora_amount - $1), updated_by = $2 WHERE id = $3',
    [amount, registeredBy, ownerId]
  );
  return recordIds;
}

async function createAliquotPaymentRecord(client, {
  paymentId, ownerId, periodId, amount, amountForPeriod = 0, amountForMora = 0,
  paymentDate, proofUrl = null, proofPublicId = null, notes = null,
  sourceType = 'MANUAL', registeredBy,
}) {
  const recordId = newId();
  await client.query(
    `INSERT INTO aliquot_payment_records
       (id, payment_id, owner_id, period_id, amount, amount_for_period,
        amount_for_mora, payment_date, proof_url, proof_public_id, notes,
        source_type, registered_by, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13)`,
    [
      recordId, paymentId, ownerId, periodId, amount, amountForPeriod,
      amountForMora, paymentDate, proofUrl, proofPublicId, notes,
      sourceType, registeredBy,
    ]
  );
  return recordId;
}

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

const ADMIN_EXPENSE_COLS = `
  ae.id,
  ae.expense_date::text AS "expenseDate",
  ae.expense_type       AS "expenseType",
  ae.category,
  ae.vendor,
  ae.description,
  ae.amount::float      AS amount,
  ae.payment_method     AS "paymentMethod",
  ae.receipt_url        AS "receiptUrl",
  ae.receipt_public_id  AS "receiptPublicId",
  ae.notes,
  ae.registered_by      AS "registeredBy",
  u.email               AS "registeredByEmail",
  ae.created_at         AS "createdAt",
  ae.updated_at         AS "updatedAt"
`;

// ── Config ────────────────────────────────────────────────────

// GET /condominium/expense-items
router.get('/expense-items', async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, description, category, expense_type AS "expenseType",
            amount::float, is_active AS "isActive", is_recurring AS "isRecurring",
            display_order AS "displayOrder", created_at AS "createdAt"
     FROM condo_expense_items
     ORDER BY display_order, created_at`
  );
  const totalFixed    = rows.filter(r => r.isActive && r.isRecurring && r.expenseType === 'FIXED')
                             .reduce((s, r) => s + r.amount, 0);
  const totalVariable = rows.filter(r => r.isActive && r.isRecurring && r.expenseType === 'VARIABLE')
                             .reduce((s, r) => s + r.amount, 0);
  success(res, { items: rows, totalFixed, totalVariable, total: totalFixed + totalVariable });
});

// POST /condominium/expense-items
router.post('/expense-items', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    name:         z.string().min(2),
    description:  z.string().nullish(),
    category:     z.enum(['MAINTENANCE','SECURITY','CLEANING','UTILITIES','ADMINISTRATION','OTHER']).default('OTHER'),
    expenseType:  z.enum(['FIXED','VARIABLE']),
    amount:       z.number().min(0),
    isActive:     z.boolean().default(true),
    isRecurring:  z.boolean().default(true),
    displayOrder: z.number().int().default(0),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO condo_expense_items
       (id, name, description, category, expense_type, amount, is_active, is_recurring, display_order, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     RETURNING id, name, description, category, expense_type AS "expenseType",
               amount::float, is_active AS "isActive", is_recurring AS "isRecurring",
               display_order AS "displayOrder", created_at AS "createdAt"`,
    [newId(), data.name, data.description || null, data.category, data.expenseType,
     data.amount, data.isActive, data.isRecurring, data.displayOrder, req.user.id]
  );
  success(res, rows[0], 201);
});

// PUT /condominium/expense-items/:id
router.put('/expense-items/:id', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    name:         z.string().min(2).optional(),
    description:  z.string().optional().nullable(),
    category:     z.enum(['MAINTENANCE','SECURITY','CLEANING','UTILITIES','ADMINISTRATION','OTHER']).optional(),
    expenseType:  z.enum(['FIXED','VARIABLE']).optional(),
    amount:       z.number().min(0).optional(),
    isActive:     z.boolean().optional(),
    isRecurring:  z.boolean().optional(),
    displayOrder: z.number().int().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE condo_expense_items SET
       name          = COALESCE($1, name),
       description   = COALESCE($2, description),
       category      = COALESCE($3, category),
       expense_type  = COALESCE($4, expense_type),
       amount        = COALESCE($5, amount),
       is_active     = COALESCE($6, is_active),
       is_recurring  = COALESCE($7, is_recurring),
       display_order = COALESCE($8, display_order),
       updated_by    = $9
     WHERE id = $10
     RETURNING id, name, description, category, expense_type AS "expenseType",
               amount::float, is_active AS "isActive", is_recurring AS "isRecurring",
               display_order AS "displayOrder", created_at AS "createdAt"`,
    [data.name || null, data.description ?? null, data.category || null, data.expenseType || null,
     data.amount ?? null, data.isActive ?? null, data.isRecurring ?? null, data.displayOrder ?? null,
     req.user.id, req.params.id]
  );
  if (!rows[0]) throw new AppError('Ítem de gasto no encontrado', 404);
  success(res, rows[0]);
});

// PATCH /condominium/expense-items/:id/toggle
router.patch('/expense-items/:id/toggle', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    `UPDATE condo_expense_items SET is_active = NOT is_active, updated_by = $1 WHERE id = $2
     RETURNING id, name, is_active AS "isActive"`,
    [req.user.id, req.params.id]
  );
  if (!rows[0]) throw new AppError('Ítem de gasto no encontrado', 404);
  success(res, rows[0]);
});

// DELETE /condominium/expense-items/:id
router.delete('/expense-items/:id', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    'DELETE FROM condo_expense_items WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Ítem de gasto no encontrado', 404);
  success(res, null, 200, 'Ítem eliminado');
});

// ── Gastos administrativos reales ──────────────────────────────

const adminExpensePayloadSchema = z.object({
  expenseDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expenseType:   z.enum(['ADMINISTRATIVE','BUILDING_SERVICE','MAINTENANCE','OTHER']).default('ADMINISTRATIVE'),
  category:      z.enum(['MAINTENANCE','SECURITY','CLEANING','UTILITIES','ADMINISTRATION','REPAIR','SUPPLIES','OTHER']).default('ADMINISTRATION'),
  vendor:        z.string().min(2).max(180),
  description:   z.string().min(3).max(800),
  amount:        z.preprocess(v => Number(v), z.number().positive()),
  paymentMethod: z.enum(['CASH','TRANSFER','CARD','CHECK','OTHER']).default('TRANSFER'),
  notes:         z.string().max(1000).optional().nullable(),
});

// GET /condominium/admin-expenses
router.get('/admin-expenses', async (req, res) => {
  const { year, month, date_from, date_to, type, category, limit } = req.query;
  const conditions = [];
  const params = [];
  if (year) {
    params.push(parseInt(year, 10));
    conditions.push(`EXTRACT(YEAR FROM ae.expense_date)::int = $${params.length}`);
  }
  if (month) {
    params.push(parseInt(month, 10));
    conditions.push(`EXTRACT(MONTH FROM ae.expense_date)::int = $${params.length}`);
  }
  if (date_from) {
    params.push(String(date_from));
    conditions.push(`ae.expense_date >= $${params.length}`);
  }
  if (date_to) {
    params.push(String(date_to));
    conditions.push(`ae.expense_date <= $${params.length}`);
  }
  if (type) {
    params.push(String(type));
    conditions.push(`ae.expense_type = $${params.length}`);
  }
  if (category) {
    params.push(String(category));
    conditions.push(`ae.category = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitValue = Math.min(Math.max(parseInt(limit || '100', 10) || 100, 1), 300);

  const { rows } = await query(
    `SELECT ${ADMIN_EXPENSE_COLS}
     FROM condo_admin_expenses ae
     LEFT JOIN users u ON u.id = ae.registered_by
     ${where}
     ORDER BY ae.expense_date DESC, ae.created_at DESC
     LIMIT ${limitValue}`,
    params
  );
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  success(res, { items: rows, total });
});

// GET /condominium/admin-expenses/summary
router.get('/admin-expenses/summary', async (req, res) => {
  const now = new Date();
  const year = parseInt(req.query.year || String(now.getFullYear()), 10);
  const month = parseInt(req.query.month || String(now.getMonth() + 1), 10);

  const [{ rows: summaryRows }, { rows: latestRows }] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(amount), 0)::float AS total,
         COUNT(*)::int AS count,
         COALESCE(SUM(CASE WHEN expense_type = 'ADMINISTRATIVE' THEN amount ELSE 0 END), 0)::float AS administrative,
         COALESCE(SUM(CASE WHEN expense_type = 'BUILDING_SERVICE' THEN amount ELSE 0 END), 0)::float AS building_services,
         COALESCE(SUM(CASE WHEN expense_type = 'MAINTENANCE' THEN amount ELSE 0 END), 0)::float AS maintenance,
         COALESCE(SUM(CASE WHEN expense_type = 'OTHER' THEN amount ELSE 0 END), 0)::float AS other
       FROM condo_admin_expenses
       WHERE EXTRACT(YEAR FROM expense_date)::int = $1
         AND EXTRACT(MONTH FROM expense_date)::int = $2`,
      [year, month]
    ),
    query(
      `SELECT ${ADMIN_EXPENSE_COLS}
       FROM condo_admin_expenses ae
       LEFT JOIN users u ON u.id = ae.registered_by
       ORDER BY ae.expense_date DESC, ae.created_at DESC
       LIMIT 5`
    ),
  ]);

  success(res, { year, month, ...summaryRows[0], latest: latestRows });
});

// POST /condominium/admin-expenses
router.post('/admin-expenses', authorize('ADMIN'), uploadSingle, async (req, res) => {
  if (!req.file) throw new AppError('El recibo de compra es obligatorio', 400);
  const data = adminExpensePayloadSchema.parse(req.body);

  const folder = `habbita/condominio/gastos-administrativos/${data.expenseDate.slice(0, 7)}`;
  const { url, publicId } = await uploadToCloudinary(
    req.file.buffer,
    folder,
    req.file.mimetype,
    req.file.originalname
  );

  try {
    const { rows } = await query(
      `INSERT INTO condo_admin_expenses
         (id, expense_date, expense_type, category, vendor, description, amount,
          payment_method, receipt_url, receipt_public_id, notes, registered_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12)
       RETURNING id`,
      [newId(), data.expenseDate, data.expenseType, data.category, data.vendor, data.description,
       data.amount, data.paymentMethod, url, publicId, data.notes || null, req.user.id]
    );
    const created = await query(
      `SELECT ${ADMIN_EXPENSE_COLS}
       FROM condo_admin_expenses ae
       LEFT JOIN users u ON u.id = ae.registered_by
       WHERE ae.id = $1`,
      [rows[0].id]
    );
    success(res, created.rows[0], 201, 'Gasto administrativo registrado');
  } catch (err) {
    await deleteFromCloudinary(publicId);
    throw err;
  }
});

// PATCH /condominium/admin-expenses/:id
router.patch('/admin-expenses/:id', authorize('ADMIN'), async (req, res) => {
  const data = adminExpensePayloadSchema.partial().parse(req.body);
  const { rows } = await query(
    `UPDATE condo_admin_expenses SET
       expense_date   = COALESCE($1, expense_date),
       expense_type   = COALESCE($2, expense_type),
       category       = COALESCE($3, category),
       vendor         = COALESCE($4, vendor),
       description    = COALESCE($5, description),
       amount         = COALESCE($6, amount),
       payment_method = COALESCE($7, payment_method),
       notes          = COALESCE($8, notes),
       updated_at     = NOW(),
       updated_by     = $9
     WHERE id = $10
     RETURNING id`,
    [data.expenseDate ?? null, data.expenseType ?? null, data.category ?? null,
     data.vendor ?? null, data.description ?? null, data.amount ?? null,
     data.paymentMethod ?? null, data.notes ?? null, req.user.id, req.params.id]
  );
  if (!rows[0]) throw new AppError('Gasto administrativo no encontrado', 404);
  const updated = await query(
    `SELECT ${ADMIN_EXPENSE_COLS}
     FROM condo_admin_expenses ae
     LEFT JOIN users u ON u.id = ae.registered_by
     WHERE ae.id = $1`,
    [req.params.id]
  );
  success(res, updated.rows[0]);
});

// DELETE /condominium/admin-expenses/:id
router.delete('/admin-expenses/:id', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    `DELETE FROM condo_admin_expenses
     WHERE id = $1
     RETURNING receipt_public_id AS "receiptPublicId"`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Gasto administrativo no encontrado', 404);
  await deleteFromCloudinary(rows[0].receiptPublicId);
  success(res, null, 200, 'Gasto administrativo eliminado');
});

// ── Catálogo de Provisiones ────────────────────────────────────

// GET /condominium/provision-catalog
router.get('/provision-catalog', async (_req, res) => {
  const { rows } = await query(
    `SELECT * FROM provision_catalog ORDER BY sort_order, created_at`
  );
  success(res, rows);
});

// POST /condominium/provision-catalog
router.post('/provision-catalog', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    name:        z.string().min(2).max(200),
    description: z.string().max(500).default(''),
    calcType:    z.enum(['PERCENTAGE','FIXED','VARIABLE']).default('PERCENTAGE'),
    value:       z.number().min(0),
    isActive:    z.boolean().default(true),
    sortOrder:   z.number().int().default(0),
  }).parse(req.body);
  const { rows } = await query(
    `INSERT INTO provision_catalog (id, name, description, calc_type, value, is_active, sort_order, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
    [newId(), data.name, data.description, data.calcType, data.value, data.isActive, data.sortOrder, req.user.id]
  );
  success(res, rows[0], 201);
});

// PATCH /condominium/provision-catalog/:id
router.patch('/provision-catalog/:id', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    name:        z.string().min(2).max(200).optional(),
    description: z.string().max(500).optional(),
    calcType:    z.enum(['PERCENTAGE','FIXED','VARIABLE']).optional(),
    value:       z.number().min(0).optional(),
    isActive:    z.boolean().optional(),
    sortOrder:   z.number().int().optional(),
  }).parse(req.body);
  const { rows } = await query(
    `UPDATE provision_catalog SET
       name        = COALESCE($1, name),
       description = COALESCE($2, description),
       calc_type   = COALESCE($3, calc_type),
       value       = COALESCE($4, value),
       is_active   = COALESCE($5, is_active),
       sort_order  = COALESCE($6, sort_order),
       updated_at  = NOW(),
       updated_by  = $7
     WHERE id = $8 RETURNING *`,
    [data.name ?? null, data.description ?? null, data.calcType ?? null,
     data.value ?? null, data.isActive ?? null, data.sortOrder ?? null,
     req.user.id, req.params.id]
  );
  if (!rows.length) throw new AppError('Provisión no encontrada', 404);
  success(res, rows[0]);
});

// DELETE /condominium/provision-catalog/:id
router.delete('/provision-catalog/:id', authorize('ADMIN'), async (req, res) => {
  const usage = await query(
    `SELECT COUNT(*)::int AS cnt FROM condo_fund_entries WHERE provision_id = $1`,
    [req.params.id]
  );
  if (usage.rows[0].cnt > 0) {
    throw new AppError('No se puede eliminar: esta provisión tiene movimientos registrados. Desactívela en su lugar.', 400);
  }
  const { rows } = await query(
    'DELETE FROM provision_catalog WHERE id = $1 RETURNING id', [req.params.id]
  );
  if (!rows.length) throw new AppError('Provisión no encontrada', 404);
  success(res, null, 200, 'Provisión eliminada');
});

// ── Config ────────────────────────────────────────────────────
router.get('/config', async (_req, res) => {
  const { rows } = await query('SELECT * FROM condo_config LIMIT 1');
  success(res, rows[0] || null);
});

// PUT /condominium/config
router.put('/config', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    name:               z.string().optional(),
    adminEmail:         z.string().email().optional(),
    fixedMaintenance:   z.number().min(0).optional(),
    fixedSecurity:      z.number().min(0).optional(),
    fixedCleaning:      z.number().min(0).optional(),
    fixedOther:         z.number().min(0).optional(),
    moraEnabled:        z.boolean().optional(),
    moraRate:           z.number().min(0).max(1).optional(),
    moraGraceDays:      z.number().int().min(0).optional(),
    capitalReservePct:  z.number().min(0).optional(),
    capitalReserveType: z.enum(['PERCENTAGE','FIXED']).optional(),
    badDebtPct:         z.number().min(0).optional(),
    badDebtType:        z.enum(['PERCENTAGE','FIXED']).optional(),
  }).parse(req.body);

  const existing = await query('SELECT id FROM condo_config LIMIT 1');

  if (!existing.rows[0]) {
    const { rows } = await query(
      `INSERT INTO condo_config
         (id, name, admin_email, fixed_maintenance, fixed_security, fixed_cleaning, fixed_other,
          mora_enabled, mora_rate, mora_grace_days,
          capital_reserve_pct, capital_reserve_type, bad_debt_pct, bad_debt_type,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
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
        data.capitalReservePct  || 0,
        data.capitalReserveType || 'PERCENTAGE',
        data.badDebtPct         || 0,
        data.badDebtType        || 'PERCENTAGE',
        req.user.id,
      ]
    );
    return success(res, rows[0], 201);
  }

  const { rows } = await query(
    `UPDATE condo_config SET
       name                 = COALESCE($1,  name),
       admin_email          = COALESCE($2,  admin_email),
       fixed_maintenance    = COALESCE($3,  fixed_maintenance),
       fixed_security       = COALESCE($4,  fixed_security),
       fixed_cleaning       = COALESCE($5,  fixed_cleaning),
       fixed_other          = COALESCE($6,  fixed_other),
       mora_enabled         = COALESCE($7,  mora_enabled),
       mora_rate            = COALESCE($8,  mora_rate),
       mora_grace_days      = COALESCE($9,  mora_grace_days),
       capital_reserve_pct  = COALESCE($10, capital_reserve_pct),
       capital_reserve_type = COALESCE($11, capital_reserve_type),
       bad_debt_pct         = COALESCE($12, bad_debt_pct),
       bad_debt_type        = COALESCE($13, bad_debt_type),
       updated_by           = $14
     WHERE id = $15 RETURNING *`,
    [
      data.name || null, data.adminEmail || null,
      data.fixedMaintenance  ?? null, data.fixedSecurity    ?? null,
      data.fixedCleaning     ?? null, data.fixedOther       ?? null,
      data.moraEnabled       ?? null, data.moraRate         ?? null,
      data.moraGraceDays     ?? null,
      data.capitalReservePct  ?? null, data.capitalReserveType || null,
      data.badDebtPct         ?? null, data.badDebtType        || null,
      req.user.id,
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

// GET /condominium/owners/payment-history — reporte de pagos y moras
router.get('/owners/payment-history', async (req, res) => {
  const filters = z.object({
    ownerId:  z.string().optional(),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(req.query);

  const params = [];
  const conditions = [];
  if (filters.ownerId) {
    params.push(filters.ownerId);
    conditions.push(`movement.owner_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `WITH movement AS (
       SELECT
         'ALIQUOT_CHARGE'::text AS movement_type,
         o.id                   AS owner_id,
         o.unit_number          AS apartment_number,
         o.name                 AS owner_name,
         MAKE_DATE(cep.year::int, cep.month::int, 1) AS movement_date,
         cep.month,
         cep.year,
         ap.id                  AS payment_id,
         NULL::text             AS record_id,
         ap.status::text        AS status,
         (ap.aliquot_amount + COALESCE((
           SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
         ), 0))::float          AS charged_amount,
         0::float               AS paid_amount,
         GREATEST(0, ap.aliquot_amount + COALESCE((
           SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
         ), 0) - ap.paid_amount)::float AS pending_amount,
         0::float               AS amount_for_period,
         0::float               AS amount_for_mora,
         0::float               AS mora_payment_amount,
         ap.notes               AS notes,
         ap.proof_url           AS proof_url,
         ap.created_at          AS created_at
       FROM aliquot_payments ap
       JOIN condo_expense_periods cep ON cep.id = ap.period_id
       JOIN condo_owners o ON o.id = ap.owner_id

       UNION ALL

       SELECT
         'PAYMENT'::text        AS movement_type,
         o.id                   AS owner_id,
         o.unit_number          AS apartment_number,
         o.name                 AS owner_name,
         pr.payment_date        AS movement_date,
         cep.month,
         cep.year,
         ap.id                  AS payment_id,
         pr.id                  AS record_id,
         ap.status::text        AS status,
         0::float               AS charged_amount,
         pr.amount::float       AS paid_amount,
         (
           o.mora_amount + CASE
             WHEN ap.status = 'OVERDUE' THEN 0
             ELSE GREATEST(0, ap.aliquot_amount + COALESCE((
               SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
             ), 0) - ap.paid_amount)
           END
         )::float               AS pending_amount,
         pr.amount_for_period::float AS amount_for_period,
         pr.amount_for_mora::float   AS amount_for_mora,
         0::float               AS mora_payment_amount,
         pr.notes               AS notes,
         pr.proof_url           AS proof_url,
         pr.created_at          AS created_at
       FROM aliquot_payment_records pr
       JOIN aliquot_payments ap ON ap.id = pr.payment_id
       JOIN condo_expense_periods cep ON cep.id = pr.period_id
       JOIN condo_owners o ON o.id = pr.owner_id

       UNION ALL

       SELECT
         'DIRECT_MORA_PAYMENT'::text AS movement_type,
         o.id                   AS owner_id,
         o.unit_number          AS apartment_number,
         o.name                 AS owner_name,
         mr.payment_date        AS movement_date,
         debt_period.month,
         debt_period.year,
         mr.aliquot_payment_id  AS payment_id,
         mr.id                  AS record_id,
         NULL::text             AS status,
         0::float               AS charged_amount,
         mr.amount::float       AS paid_amount,
         o.mora_amount::float   AS pending_amount,
         0::float               AS amount_for_period,
         mr.amount::float       AS amount_for_mora,
         mr.amount::float       AS mora_payment_amount,
         mr.notes               AS notes,
         mr.proof_url           AS proof_url,
         mr.created_at          AS created_at
       FROM mora_payment_records mr
       JOIN condo_owners o ON o.id = mr.owner_id
       LEFT JOIN aliquot_payments debt_payment ON debt_payment.id = mr.debt_payment_id
       LEFT JOIN condo_expense_periods debt_period ON debt_period.id = debt_payment.period_id
       WHERE mr.payment_type = 'DIRECT'

     )
     SELECT
       movement_type      AS "movementType",
       owner_id           AS "ownerId",
       apartment_number   AS "apartmentNumber",
       owner_name         AS "ownerName",
       movement_date      AS "movementDate",
       month,
       year,
       payment_id         AS "paymentId",
       record_id          AS "recordId",
       status,
       charged_amount     AS "chargedAmount",
       paid_amount        AS "paidAmount",
       pending_amount     AS "pendingAmount",
       amount_for_period  AS "amountForPeriod",
       amount_for_mora    AS "amountForMora",
       mora_payment_amount AS "moraPaymentAmount",
       notes,
       proof_url          AS "proofUrl",
       created_at         AS "createdAt"
     FROM movement
     ${where}
     ORDER BY apartment_number, movement_date ASC,
       CASE
         WHEN movement_type = 'ALIQUOT_CHARGE' THEN 1
         WHEN movement_type IN ('PAYMENT','DIRECT_MORA_PAYMENT') AND amount_for_mora > 0 THEN 2
         WHEN movement_type IN ('PAYMENT','DIRECT_MORA_PAYMENT') THEN 3
         ELSE 4
       END,
       year ASC NULLS LAST,
       month ASC NULLS LAST,
       created_at ASC NULLS LAST,
       record_id NULLS FIRST`,
    params
  );

  const dateOnly = (value) => {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  };
  const ownerBalances = new Map();
  const rowsWithRunningBalance = rows.map((row, index) => {
    const previousBalance = ownerBalances.get(row.ownerId) || 0;
    const debit = row.movementType === 'ALIQUOT_CHARGE' ? Number(row.chargedAmount || 0) : 0;
    const credit = row.movementType === 'PAYMENT' || row.movementType === 'DIRECT_MORA_PAYMENT'
      ? Number(row.paidAmount || 0)
      : 0;
    const nextBalance = Math.max(0, Math.round((previousBalance + debit - credit) * 100) / 100);
    ownerBalances.set(row.ownerId, nextBalance);
    return { ...row, pendingAmount: nextBalance, statementOrder: index };
  });

  const filteredRows = rowsWithRunningBalance.filter((row) => {
    const rowDate = dateOnly(row.movementDate);
    return (!filters.dateFrom || rowDate >= filters.dateFrom) &&
      (!filters.dateTo || rowDate <= filters.dateTo);
  });

  const reportRows = [...filteredRows].sort((first, second) =>
    String(first.apartmentNumber).localeCompare(String(second.apartmentNumber), 'es', { numeric: true, sensitivity: 'base' }) ||
    dateOnly(second.movementDate).localeCompare(dateOnly(first.movementDate)) ||
    (Number(second.statementOrder || 0) - Number(first.statementOrder || 0)) ||
    (Number(second.year || 0) - Number(first.year || 0)) ||
    (Number(second.month || 0) - Number(first.month || 0))
  );

  const moraParams = filters.ownerId ? [filters.ownerId] : [];
  const moraRes = await query(
    `SELECT COALESCE(SUM(mora_amount), 0)::float AS total
     FROM condo_owners ${filters.ownerId ? 'WHERE id = $1' : ''}`,
    moraParams
  );
  const currentMora = parseFloat(moraRes.rows[0]?.total) || 0;

  const latestBalanceByOwner = new Map();
  for (const row of filteredRows) latestBalanceByOwner.set(row.ownerId, Number(row.pendingAmount || 0));

  const summary = reportRows.reduce((acc, row) => {
    acc.totalCharged += Number(row.chargedAmount || 0);
    acc.totalPaid += row.movementType === 'PAYMENT' || row.movementType === 'DIRECT_MORA_PAYMENT'
      ? Number(row.paidAmount || 0)
      : 0;
    acc.totalAppliedToMora += Number(row.amountForMora || 0);
    return acc;
  }, { totalCharged: 0, totalPaid: 0, totalPending: 0, totalAppliedToMora: 0, currentMora });
  summary.totalPending = [...latestBalanceByOwner.values()].reduce((sum, balance) => sum + balance, 0);

  success(res, { rows: reportRows, summary });
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
    `INSERT INTO condo_owners (id, name, email, phone, unit_number, participation_pct, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     RETURNING ${OWNER_COLS}`,
    [newId(), data.fullName, data.email || null, data.phone || null, data.apartmentNumber, data.participationPct, req.user.id]
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
            SET name = $1, participation_pct = $2, updated_by = $3
          WHERE unit_number = $4`,
        [name, pct, req.user.id, unitNumber]
      );
      updated++;
    } else {
      await query(
        `INSERT INTO condo_owners (id, name, unit_number, participation_pct, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [newId(), name, unitNumber, pct, req.user.id]
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
       is_active         = COALESCE($6, is_active),
       updated_by        = $7
     WHERE id = $8
     RETURNING ${OWNER_COLS}`,
    [
      data.fullName || null, data.email ?? null, data.phone ?? null,
      data.apartmentNumber || null, data.participationPct ?? null,
      data.isActive ?? null, req.user.id, req.params.id,
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
    `UPDATE condo_owners SET is_active = NOT is_active, updated_by = $1
     WHERE id = $2
     RETURNING ${OWNER_COLS}`,
    [req.user.id, req.params.id]
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
    `UPDATE condo_owners SET mora_amount = ${moraSql}, updated_by = $2
     WHERE id = $3
     RETURNING ${OWNER_COLS}`,
    [amount, req.user.id, req.params.id]
  );
  if (!rows[0]) throw new AppError('Propietario no encontrado', 404);
  success(res, rows[0], 200, `Mora ajustada (${operation} ${amount})`);
});

// POST /condominium/owners/:id/mora/payments — abono directo a mora con comprobante
router.post('/owners/:id/mora/payments', authorize('ADMIN'), uploadSingle, async (req, res) => {
  if (!req.file) throw new AppError('Comprobante requerido', 400);
  const data = z.object({
    amount:      z.coerce.number().positive(),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de pago inválida'),
    notes:       z.string().max(500).optional(),
  }).parse(req.body);

  const ownerRes = await query('SELECT * FROM condo_owners WHERE id = $1', [req.params.id]);
  const owner = ownerRes.rows[0];
  if (!owner) throw new AppError('Propietario no encontrado', 404);
  const currentMora = parseFloat(owner.mora_amount);
  if (data.amount > currentMora + 0.01) {
    throw new AppError(`El abono excede la mora disponible de $${currentMora.toFixed(2)}`, 400);
  }

  const folder = `habbita/condominio/comprobantes/mora/${data.paymentDate.slice(0, 7)}`;
  const { url, publicId } = await uploadToCloudinary(
    req.file.buffer, folder, req.file.mimetype, req.file.originalname
  );
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const recordIds = await applyMoraPayment(client, {
      ownerId: owner.id, amount: data.amount, paymentDate: data.paymentDate,
      paymentType: 'DIRECT', proofUrl: url, proofPublicId: publicId,
      notes: data.notes || null, registeredBy: req.user.id,
    });
    const ownerUpdate = await client.query(
      `SELECT ${OWNER_COLS} FROM condo_owners WHERE id = $1`, [owner.id]
    );
    await client.query('COMMIT');
    success(res, { owner: ownerUpdate.rows[0], recordIds }, 201, 'Abono a mora registrado');
  } catch (err) {
    await client.query('ROLLBACK');
    try { await deleteFromCloudinary(publicId); } catch (_) { /* best-effort */ }
    throw err;
  } finally {
    client.release();
  }
});

// ── OCR de comprobantes ────────────────────────────────────────

// POST /condominium/ocr/scan
// Recibe el archivo desde la web y lo reenvía al servicio OCR. Así el
// navegador no necesita conocer ni tener acceso a una segunda URL base.
router.post('/ocr/scan', authorize('ADMIN'), uploadSingle, async (req, res) => {
  if (!req.file) throw new AppError('Archivo requerido', 400);

  const form = new FormData();
  form.append(
    'file',
    new Blob([req.file.buffer], { type: req.file.mimetype }),
    req.file.originalname
  );

  let ocrResponse;
  try {
    ocrResponse = await fetch(config.ocr.scanUrl, { method: 'POST', body: form });
  } catch (_) {
    throw new AppError('No fue posible conectar con el servicio OCR', 502);
  }

  let ocrResult;
  try {
    ocrResult = await ocrResponse.json();
  } catch (_) {
    throw new AppError('El servicio OCR devolvió una respuesta inválida', 502);
  }
  if (!ocrResponse.ok || !ocrResult.success) {
    throw new AppError(ocrResult.error || 'No se pudo leer el comprobante', 422);
  }

  const extractedData = ocrResult.extracted_data || {};
  let matches = [];
  let suggestedMatches = [];

  // El período es opcional para conservar un endpoint OCR reutilizable. Al
  // recibirlo, la respuesta ya incluye el pago del período que puede confirmarse.
  if (req.body.periodId) {
    const { rows } = await query(
      `SELECT ap.id AS "paymentId", ap.status AS "paymentStatus",
              ap.aliquot_amount::float AS "aliquotAmount",
              ap.mora_at_billing::float AS "moraAtBilling",
              ap.paid_amount::float AS "amountPaid",
              (ap.aliquot_amount + COALESCE((
                SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
              ), 0))::float AS "totalDue",
              o.id AS "ownerId", o.name AS "ownerName", o.unit_number AS "apartmentNumber"
       FROM aliquot_payments ap
       JOIN condo_owners o ON o.id = ap.owner_id
       WHERE ap.period_id = $1
       ORDER BY o.unit_number`,
      [req.body.periodId]
    );
    matches = findOwnerMatches(extractedData.sender_name, rows).map(toOcrOwnerMatch);
    if (!matches.length) {
      suggestedMatches = findPaymentAmountMatches(numericAmount(extractedData.amount), rows).map(toOcrOwnerMatch);
    }
  }

  success(res, {
    filename: ocrResult.filename || req.file.originalname,
    extractedData,
    matches,
    suggestedMatches,
  });
});

// POST /condominium/movements/scan
// Lee un estado de movimientos bancarios en PDF. Solo devuelve ingresos (+);
// la confirmación posterior reutiliza el flujo seguro de comprobantes OCR.
router.post('/movements/scan', authorize('ADMIN'), uploadSingle, async (req, res) => {
  if (!req.file) throw new AppError('Archivo requerido', 400);
  if (req.file.mimetype !== 'application/pdf' && !/\.pdf$/i.test(req.file.originalname)) {
    throw new AppError('Selecciona el PDF de movimientos bancarios', 400);
  }
  const periodId = z.string().parse(req.body.periodId);

  const form = new FormData();
  form.append(
    'file',
    new Blob([req.file.buffer], { type: req.file.mimetype }),
    req.file.originalname,
  );

  let movementsResponse;
  try {
    movementsResponse = await fetch(config.ocr.movementsScanUrl, { method: 'POST', body: form });
  } catch (_) {
    throw new AppError('No fue posible conectar con el servicio OCR', 502);
  }

  let movementsResult;
  try {
    movementsResult = await movementsResponse.json();
  } catch (_) {
    throw new AppError('El servicio OCR devolvió una respuesta inválida', 502);
  }
  if (!movementsResponse.ok || !movementsResult.success) {
    throw new AppError(movementsResult.error || 'No se pudo leer el PDF de movimientos', 422);
  }

  const transactions = (Array.isArray(movementsResult.records) ? movementsResult.records : [])
    .map((record, index) => ({
      id: String(record.id || `movement-${index + 1}`),
      paymentDate: String(record.payment_date || ''),
      amount: Number(record.amount),
      description: String(record.description || '').trim(),
    }))
    .filter(transaction =>
      /^\d{4}-\d{2}-\d{2}$/.test(transaction.paymentDate) &&
      Number.isFinite(transaction.amount) && transaction.amount > 0
    );
  if (!transactions.length) {
    throw new AppError('No se encontraron ingresos (+) en el formato de movimientos bancarios', 422);
  }

  const { rows } = await query(
    `SELECT ap.id AS "paymentId", ap.status AS "paymentStatus",
            ap.aliquot_amount::float AS "aliquotAmount",
            ap.mora_at_billing::float AS "moraAtBilling",
            ap.paid_amount::float AS "amountPaid",
            (ap.aliquot_amount + COALESCE((
              SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
            ), 0))::float AS "totalDue",
            o.id AS "ownerId", o.name AS "ownerName", o.unit_number AS "apartmentNumber"
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     WHERE ap.period_id = $1
     ORDER BY o.unit_number`,
    [periodId]
  );

  const result = transactions.map(transaction => ({
    ...transaction,
    matches: findOwnerMatches(transaction.description, rows).map(toOcrOwnerMatch),
    suggestedMatches: [],
  }));

  for (const transaction of result) {
    if (!transaction.matches.length) {
      transaction.suggestedMatches = findPaymentAmountMatches(transaction.amount, rows).map(toOcrOwnerMatch);
    }
  }

  // El estado de cuenta es un único comprobante fuente: se almacena una sola
  // vez y todos los pagos confirmados desde esta importación lo referencian.
  const movementProof = await uploadToCloudinary(
    req.file.buffer,
    `habbita/condominio/movimientos/${periodId}`,
    req.file.mimetype,
    req.file.originalname
  );

  success(res, {
    filename: movementsResult.filename || req.file.originalname,
    proofUrl: movementProof.url,
    proofPublicId: movementProof.publicId,
    transactions: result,
  });
});

async function buildBalancePdfBuffer({ year, month }) {
  const conditions = [];
  const params = [];
  if (year) {
    params.push(parseInt(year, 10));
    conditions.push(`cep.year = $${params.length}`);
  }
  if (month) {
    params.push(parseInt(month, 10));
    conditions.push(`cep.month >= $${params.length}`);
    params.push(parseInt(month, 10));
    conditions.push(`cep.month <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const periodsRes = await query(
    `SELECT cep.*,
            COALESCE(SUM(CASE WHEN ap.status = 'PAID' THEN ap.paid_amount ELSE 0 END), 0) AS total_collected,
            COALESCE(SUM(ap.aliquot_amount + COALESCE((
              SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
            ), 0)), 0) AS total_billed
     FROM condo_expense_periods cep
     LEFT JOIN aliquot_payments ap ON ap.period_id = cep.id
     ${where}
     GROUP BY cep.id
     ORDER BY cep.year ASC, cep.month ASC`,
    params
  );

  const periodIds = periodsRes.rows.map(p => p.id);
  let expenseItems = [], periodProvisions = [];
  if (periodIds.length > 0) {
    const [itemsRes, provisionsRes] = await Promise.all([
      query(
        `SELECT period_id, name, category, expense_type, amount::float AS amount
         FROM condo_period_expense_items
         WHERE period_id = ANY($1)
         ORDER BY created_at`,
        [periodIds]
      ),
      query(
        `SELECT fe.period_id, fe.provision_id, COALESCE(pc.name, fe.fund_type) AS name,
                fe.amount::float AS amount
         FROM condo_fund_entries fe
         LEFT JOIN provision_catalog pc ON pc.id = fe.provision_id
         WHERE fe.period_id = ANY($1) AND fe.entry_type = 'PROVISION'
         ORDER BY fe.entry_date ASC`,
        [periodIds]
      ),
    ]);
    expenseItems = itemsRes.rows;
    periodProvisions = provisionsRes.rows;
  }

  const adminExpensesRes = await query(
    `SELECT id, expense_date::text AS "expenseDate",
            EXTRACT(YEAR FROM expense_date)::int AS year,
            EXTRACT(MONTH FROM expense_date)::int AS month,
            expense_type AS "expenseType", category, vendor, description,
            amount::float AS amount
     FROM condo_admin_expenses ae
     WHERE EXTRACT(YEAR FROM ae.expense_date)::int = $1
       AND EXTRACT(MONTH FROM ae.expense_date)::int = $2
     ORDER BY expense_date ASC, created_at ASC`,
    [parseInt(year, 10), parseInt(month, 10)]
  );

  const periods = periodsRes.rows.map(period => ({
    ...period,
    expense_items: expenseItems.filter(item => item.period_id === period.id),
    provisions: periodProvisions.filter(provision => provision.period_id === period.id),
    admin_expenses: adminExpensesRes.rows.filter(expense => expense.year === period.year && expense.month === period.month),
  }));

  const moraRes = await query(
    `SELECT COALESCE(SUM(mora_amount), 0)::float AS total_mora FROM condo_owners WHERE mora_amount > 0`
  );
  const totalMora = parseFloat(moraRes.rows[0]?.total_mora) || 0;

  const cfgRes = await query('SELECT name FROM condo_config LIMIT 1');
  const condoName = cfgRes.rows[0]?.name || 'Condominio';

  return generateBalancePdf({
    condoName,
    periods,
    totalMora,
    year: parseInt(year, 10),
    month_from: parseInt(month, 10),
    month_to: parseInt(month, 10),
  });
}

async function getPeriodSummaryPdfData(periodId) {
  const periodRes = await query('SELECT * FROM condo_expense_periods WHERE id = $1', [periodId]);
  const period = periodRes.rows[0];
  if (!period) throw new AppError('Período no encontrado', 404);

  const [itemsRes, provisionsRes, cfgRes] = await Promise.all([
    query(
      `SELECT period_id, name, category, expense_type, amount::float AS amount
       FROM condo_period_expense_items
       WHERE period_id = $1
       ORDER BY expense_type DESC, created_at ASC`,
      [periodId]
    ),
    query(
      `SELECT fe.period_id, fe.provision_id, COALESCE(pc.name, fe.fund_type) AS name,
              fe.amount::float AS amount, fe.description
       FROM condo_fund_entries fe
       LEFT JOIN provision_catalog pc ON pc.id = fe.provision_id
       WHERE fe.period_id = $1 AND fe.entry_type = 'PROVISION'
       ORDER BY fe.entry_date ASC, fe.created_at ASC`,
      [periodId]
    ),
    query('SELECT name FROM condo_config LIMIT 1'),
  ]);

  return {
    condoName: cfgRes.rows[0]?.name || 'Condominio',
    period,
    expenseItems: itemsRes.rows,
    provisions: provisionsRes.rows,
  };
}

async function buildPeriodSummaryPdfBuffer(periodId) {
  return generatePeriodSummaryPdf(await getPeriodSummaryPdfData(periodId));
}

function previousMonthOf(year, month) {
  const numericYear = parseInt(year, 10);
  const numericMonth = parseInt(month, 10);
  return numericMonth === 1
    ? { year: numericYear - 1, month: 12 }
    : { year: numericYear, month: numericMonth - 1 };
}

async function getPaymentExtras(paymentId) {
  const { rows } = await query(
    `SELECT id, amount::float AS amount, notes, created_at
     FROM aliquot_payment_extras
     WHERE payment_id = $1
     ORDER BY created_at ASC`,
    [paymentId]
  );
  return rows;
}

async function getOwnerMoraDebts(ownerId, ownerMoraAmount = 0) {
  const { rows } = await query(
    `SELECT
       ap.id AS payment_id,
       cep.month,
       cep.year,
       ap.aliquot_amount::float AS aliquot_amount,
       COALESCE((
         SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
       ), 0)::float AS extras_total,
       ap.paid_amount::float AS paid_amount,
       GREATEST(0, ap.aliquot_amount + COALESCE((
         SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
       ), 0) - ap.paid_amount)::float AS pending_amount
     FROM aliquot_payments ap
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE ap.owner_id = $1
       AND ap.status = 'OVERDUE'
       AND GREATEST(0, ap.aliquot_amount + COALESCE((
         SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
       ), 0) - ap.paid_amount) > 0.01
     ORDER BY cep.year ASC, cep.month ASC`,
    [ownerId]
  );

  const debtTotal = rows.reduce((sum, debt) => sum + (parseFloat(debt.pending_amount) || 0), 0);
  const residualMora = Math.max(0, (parseFloat(ownerMoraAmount) || 0) - debtTotal);
  if (residualMora > 0.01) {
    rows.push({
      payment_id: null,
      label: 'Mora sin período asociado',
      month: null,
      year: null,
      aliquot_amount: 0,
      extras_total: 0,
      paid_amount: 0,
      pending_amount: Math.round(residualMora * 100) / 100,
    });
  }

  return rows;
}

async function buildAliquotEmailAttachments(payment, sharedPeriodPdfs = null) {
  const extras = await getPaymentExtras(payment.id);
  const moraDebts = await getOwnerMoraDebts(payment.owner_id, payment.owner_mora_amount);
  payment.extras = extras;
  const periodSummaryData = sharedPeriodPdfs?.periodSummaryData ||
    await getPeriodSummaryPdfData(payment.period_id);
  const previous = previousMonthOf(payment.year, payment.month);
  const previousBalancePdf = sharedPeriodPdfs?.previousBalancePdf ||
    await buildBalancePdfBuffer(previous);

  return [
    {
      filename: `resumen-alicuota-depto-${payment.unit_number}-${payment.year}-${String(payment.month).padStart(2, '0')}.pdf`,
      content: await generateAliquotEmailSummaryPdf({ ...periodSummaryData, payment, extras, moraDebts }),
      contentType: 'application/pdf',
    },
    {
      filename: `balance-periodo-anterior-${previous.year}-${String(previous.month).padStart(2, '0')}.pdf`,
      content: previousBalancePdf,
      contentType: 'application/pdf',
    },
  ];
}

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
    `SELECT
       ap.id,
       ap.period_id              AS "periodId",
       ap.owner_id               AS "ownerId",
       ap.aliquot_amount::float  AS "aliquotAmount",
       ap.mora_at_billing::float AS "moraAtBilling",
       COALESCE((
         SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
       ), 0)::float              AS "extrasTotal",
       (ap.aliquot_amount + COALESCE((
         SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
       ), 0))::float             AS "totalDue",
       ap.paid_amount::float     AS "amountPaid",
       ap.payment_date           AS "paymentDate",
       ap.proof_url              AS "proofUrl",
       ap.proof_public_id        AS "proofPublicId",
       EXISTS (
         SELECT 1 FROM mora_payment_records mr WHERE mr.debt_payment_id = ap.id
       )                         AS "wasOverdue",
       COALESCE((
         SELECT JSON_AGG(
           JSON_BUILD_OBJECT(
             'id',          mr.id,
             'amount',      mr.amount::float,
             'paymentDate', mr.payment_date,
             'proofUrl',    mr.proof_url,
             'notes',       mr.notes
           ) ORDER BY mr.payment_date ASC, mr.created_at ASC
         )
         FROM mora_payment_records mr
         WHERE mr.debt_payment_id = ap.id
       ), '[]'::json)            AS "moraPaymentProofs",
       COALESCE((
         SELECT JSON_AGG(
           JSON_BUILD_OBJECT(
             'id',              pr.id,
             'amount',          pr.amount::float,
             'amountForPeriod', pr.amount_for_period::float,
             'amountForMora',   pr.amount_for_mora::float,
             'paymentDate',     pr.payment_date,
             'proofUrl',        pr.proof_url,
             'proofPublicId',   pr.proof_public_id,
             'notes',           pr.notes,
             'sourceType',      pr.source_type,
             'createdAt',       pr.created_at
           ) ORDER BY pr.payment_date ASC, pr.created_at ASC
         )
         FROM aliquot_payment_records pr
         WHERE pr.payment_id = ap.id
       ), '[]'::json)            AS "paymentRecords",
       ap.status,
       ap.notes,
       ap.created_at             AS "createdAt",
       ap.updated_at             AS "updatedAt",
       JSON_BUILD_OBJECT(
         'id',             o.id,
         'fullName',       o.name,
         'apartmentNumber',o.unit_number,
         'participationPct', o.participation_pct::float,
         'moraAmount',     o.mora_amount::float,
         'email',          o.email
       ) AS owner,
       COALESCE((
         SELECT JSON_AGG(
           JSON_BUILD_OBJECT(
             'id',        e.id,
             'amount',    e.amount::float,
             'notes',     e.notes,
             'createdAt', e.created_at
           ) ORDER BY e.created_at
         )
         FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
       ), '[]'::json)            AS extras
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     WHERE ap.period_id = $1
     ORDER BY o.unit_number`,
    [req.params.id]
  );

  const provisionsRes = await query(
    `SELECT
       fe.id,
       fe.provision_id AS "provisionId",
       COALESCE(pc.name, fe.fund_type) AS name,
       fe.amount::float AS amount,
       fe.description,
       fe.created_at AS "createdAt"
     FROM condo_fund_entries fe
     LEFT JOIN provision_catalog pc ON pc.id = fe.provision_id
     WHERE fe.period_id = $1 AND fe.entry_type = 'PROVISION'
     ORDER BY fe.created_at ASC`,
    [req.params.id]
  );

  success(res, { ...periodRes.rows[0], payments: paymentsRes.rows, provisions: provisionsRes.rows });
});

// POST /condominium/periods
router.post('/periods', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    month:            z.number().int().min(1).max(12),
    year:             z.number().int().min(1990),
    // Lista de ítems con montos explícitos (nueva UI)
    items:            z.array(z.object({
      expenseItemId: z.string().nullable().optional(),
      name:          z.string().min(1).default('Gasto'),
      category:      z.enum(['MAINTENANCE','SECURITY','CLEANING','UTILITIES','ADMINISTRATION','OTHER']).default('OTHER'),
      expenseType:   z.enum(['FIXED','VARIABLE']).default('FIXED'),
      amount:        z.number().min(0),
    })).optional(),
    // Campos legacy para compatibilidad
    variableExpenses: z.number().min(0).default(0),
    variableNotes:    z.string().optional(),
    notes:            z.string().optional(),
    // Provisiones seleccionadas (IDs del catálogo). Si se omite → todas las activas.
    provisionIds:     z.array(z.string()).optional(),
    // Montos para provisiones VARIABLE (provision_id → amount)
    provisionAmounts: z.record(z.string(), z.number().min(0)).optional(),
  }).parse(req.body);

  const configRes = await query('SELECT * FROM condo_config LIMIT 1');
  const cfg = configRes.rows[0];
  if (!cfg) throw new AppError('Configure el condominio primero', 400);

  const periodId = newId();
  let snapshotItems = [];

  if (data.items && data.items.length > 0) {
    // Usar los ítems enviados por la UI (con montos ya decididos por el usuario)
    snapshotItems = data.items.map(i => ({
      expenseItemId: i.expenseItemId ?? null,
      name:          i.name,
      category:      i.category,
      expenseType:   i.expenseType,
      amount:        parseFloat(String(i.amount)) || 0,
    }));
  } else {
    // Fallback: ítems activos y recurrentes del catálogo
    const itemsRes = await query(
      `SELECT * FROM condo_expense_items WHERE is_active = TRUE AND is_recurring = TRUE ORDER BY display_order, created_at`
    );
    if (itemsRes.rows.length > 0) {
      snapshotItems = itemsRes.rows.map(r => ({
        expenseItemId: r.id,
        name:          r.name,
        category:      r.category,
        expenseType:   r.expense_type,
        amount:        parseFloat(r.amount),
      }));
    } else {
      // Fallback final: condo_config
      const cfgItems = [
        { expenseItemId: null, name: 'Mantenimiento', category: 'MAINTENANCE', expenseType: 'FIXED', amount: parseFloat(cfg.fixed_maintenance) || 0 },
        { expenseItemId: null, name: 'Seguridad',     category: 'SECURITY',    expenseType: 'FIXED', amount: parseFloat(cfg.fixed_security)    || 0 },
        { expenseItemId: null, name: 'Limpieza',      category: 'CLEANING',    expenseType: 'FIXED', amount: parseFloat(cfg.fixed_cleaning)    || 0 },
        { expenseItemId: null, name: 'Otros',         category: 'OTHER',       expenseType: 'FIXED', amount: parseFloat(cfg.fixed_other)       || 0 },
      ];
      snapshotItems = cfgItems.filter(i => i.amount > 0);
    }
    if (data.variableExpenses > 0) {
      snapshotItems.push({
        expenseItemId: null, name: 'Gastos variables',
        category: 'OTHER', expenseType: 'VARIABLE', amount: data.variableExpenses,
      });
    }
  }

  // Calcular totales por categoría (para las columnas legacy del período)
  // Solo items de tipo FIXED para evitar doble conteo con variable_expenses
  const sumCat = (cat) => snapshotItems.filter(i => i.category === cat && i.expenseType === 'FIXED').reduce((s, i) => s + i.amount, 0);
  const fixedMaintenance = sumCat('MAINTENANCE');
  const fixedSecurity    = sumCat('SECURITY');
  const fixedCleaning    = sumCat('CLEANING');
  const fixedOther       = snapshotItems
    .filter(i => i.expenseType === 'FIXED' && !['MAINTENANCE','SECURITY','CLEANING'].includes(i.category))
    .reduce((s, i) => s + i.amount, 0);
  const variableTotal  = snapshotItems.filter(i => i.expenseType === 'VARIABLE').reduce((s, i) => s + i.amount, 0);
  const totalExpenses  = snapshotItems.reduce((s, i) => s + i.amount, 0);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Calcular provisiones desde el catálogo (activas y en la selección del usuario)
    const hasProvisionSelection = Array.isArray(data.provisionIds);
    const provFilter = hasProvisionSelection
      ? `AND id = ANY($1)`
      : '';
    const provParams = hasProvisionSelection
      ? [data.provisionIds]
      : [];
    const provCatalog = await query(
      `SELECT * FROM provision_catalog WHERE is_active = TRUE ${provFilter} ORDER BY sort_order, created_at`,
      provParams
    );
    const nonPercentageProvisionTotal = provCatalog.rows.reduce((sum, p) => {
      const pVal = parseFloat(p.value) || 0;
      if (p.calc_type === 'FIXED') return sum + pVal;
      if (p.calc_type === 'VARIABLE') {
        const overrideAmt = data.provisionAmounts?.[p.id];
        return sum + (overrideAmt != null ? parseFloat(String(overrideAmt)) || 0 : 0);
      }
      return sum;
    }, 0);
    const percentageBase = totalExpenses + nonPercentageProvisionTotal;
    const provisionResults = provCatalog.rows.map(p => {
      const pVal = parseFloat(p.value) || 0;
      let amount;
      if (p.calc_type === 'FIXED') {
        amount = Math.round(pVal * 100) / 100;
      } else if (p.calc_type === 'VARIABLE') {
        const overrideAmt = data.provisionAmounts?.[p.id];
        amount = overrideAmt != null ? Math.round(overrideAmt * 100) / 100 : 0;
      } else {
        amount = Math.round(percentageBase * pVal / 100 * 100) / 100;
      }
      return { ...p, calculatedAmount: amount };
    });
    const totalProvisions = Math.round(provisionResults.reduce((s, p) => s + p.calculatedAmount, 0) * 100) / 100;
    const grandTotal      = totalExpenses + totalProvisions;

    // Valores legacy para compatibilidad con balance report
    const capitalReserve   = totalProvisions;
    const badDebtProvision = 0;

    const { rows } = await client.query(
      `INSERT INTO condo_expense_periods
         (id, month, year, fixed_maintenance, fixed_security, fixed_cleaning, fixed_other,
          variable_expenses, variable_notes, total_expenses,
          capital_reserve, bad_debt_provision, total_provisions, grand_total,
          notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,
      [
        periodId, data.month, data.year,
        fixedMaintenance, fixedSecurity, fixedCleaning, fixedOther,
        variableTotal, data.variableNotes || null, totalExpenses,
        capitalReserve, badDebtProvision, totalProvisions, grandTotal,
        data.notes || null, req.user.id,
      ]
    );

    for (const item of snapshotItems) {
      if (item.amount <= 0) continue;
      await client.query(
        `INSERT INTO condo_period_expense_items
           (id, period_id, expense_item_id, name, category, expense_type, amount, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [newId(), periodId, item.expenseItemId, item.name, item.category, item.expenseType, item.amount, req.user.id]
      );
    }

    // Crear entradas del libro auxiliar de fondos (misma transacción)
    for (const p of provisionResults) {
      if (p.calculatedAmount <= 0) continue;
      await client.query(
        `INSERT INTO condo_fund_entries
           (id, fund_type, provision_id, amount, entry_type, period_id, description, registered_by, created_by, updated_by)
         VALUES ($1,'PROVISION',$2,$3,'PROVISION',$4,$5,$6,$6,$6)`,
        [newId(), p.id, p.calculatedAmount, periodId,
         `Provisión ${p.name} — Período ${data.month}/${data.year}`, req.user.id]
      );
    }

    await client.query('COMMIT');
    success(res, rows[0], 201);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /condominium/periods/:id — editar período en borrador
router.patch('/periods/:id', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    month:            z.number().int().min(1).max(12),
    year:             z.number().int().min(1990),
    items:            z.array(z.object({
      expenseItemId: z.string().nullable().optional(),
      name:          z.string().min(1).default('Gasto'),
      category:      z.enum(['MAINTENANCE','SECURITY','CLEANING','UTILITIES','ADMINISTRATION','OTHER']).default('OTHER'),
      expenseType:   z.enum(['FIXED','VARIABLE']).default('FIXED'),
      amount:        z.number().min(0),
    })).min(1),
    variableNotes:    z.string().optional(),
    notes:            z.string().optional(),
    provisionIds:     z.array(z.string()).optional(),
    provisionAmounts: z.record(z.string(), z.number().min(0)).optional(),
  }).parse(req.body);

  const snapshotItems = data.items.map(i => ({
    expenseItemId: i.expenseItemId ?? null,
    name:          i.name,
    category:      i.category,
    expenseType:   i.expenseType,
    amount:        parseFloat(String(i.amount)) || 0,
  })).filter(i => i.amount > 0);
  if (!snapshotItems.length) throw new AppError('Agrega al menos un gasto con monto mayor a cero', 400);

  const sumCat = (cat) => snapshotItems.filter(i => i.category === cat && i.expenseType === 'FIXED').reduce((s, i) => s + i.amount, 0);
  const fixedMaintenance = sumCat('MAINTENANCE');
  const fixedSecurity    = sumCat('SECURITY');
  const fixedCleaning    = sumCat('CLEANING');
  const fixedOther       = snapshotItems
    .filter(i => i.expenseType === 'FIXED' && !['MAINTENANCE','SECURITY','CLEANING'].includes(i.category))
    .reduce((s, i) => s + i.amount, 0);
  const variableTotal  = snapshotItems.filter(i => i.expenseType === 'VARIABLE').reduce((s, i) => s + i.amount, 0);
  const totalExpenses  = snapshotItems.reduce((s, i) => s + i.amount, 0);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const periodRes = await client.query('SELECT * FROM condo_expense_periods WHERE id = $1 FOR UPDATE', [req.params.id]);
    const period = periodRes.rows[0];
    if (!period) throw new AppError('Período no encontrado', 404);
    if (period.status !== 'DRAFT') throw new AppError('Solo se pueden editar períodos en borrador', 400);

    const hasProvisionSelection = Array.isArray(data.provisionIds);
    const provCatalog = hasProvisionSelection && data.provisionIds.length
      ? await client.query(
          `SELECT * FROM provision_catalog WHERE id = ANY($1) ORDER BY sort_order, created_at`,
          [data.provisionIds]
        )
      : { rows: [] };
    const nonPercentageProvisionTotal = provCatalog.rows.reduce((sum, p) => {
      const pVal = parseFloat(p.value) || 0;
      if (p.calc_type === 'FIXED') return sum + pVal;
      if (p.calc_type === 'VARIABLE') {
        const overrideAmt = data.provisionAmounts?.[p.id];
        return sum + (overrideAmt != null ? parseFloat(String(overrideAmt)) || 0 : 0);
      }
      return sum;
    }, 0);
    const percentageBase = totalExpenses + nonPercentageProvisionTotal;
    const provisionResults = provCatalog.rows.map(p => {
      const pVal = parseFloat(p.value) || 0;
      let amount;
      if (p.calc_type === 'FIXED') {
        amount = Math.round(pVal * 100) / 100;
      } else if (p.calc_type === 'VARIABLE') {
        const overrideAmt = data.provisionAmounts?.[p.id];
        amount = overrideAmt != null ? Math.round(overrideAmt * 100) / 100 : 0;
      } else {
        amount = Math.round(percentageBase * pVal / 100 * 100) / 100;
      }
      return { ...p, calculatedAmount: amount };
    });
    const totalProvisions = Math.round(provisionResults.reduce((s, p) => s + p.calculatedAmount, 0) * 100) / 100;
    const grandTotal      = totalExpenses + totalProvisions;

    const { rows } = await client.query(
      `UPDATE condo_expense_periods
       SET month = $2,
           year = $3,
           fixed_maintenance = $4,
           fixed_security = $5,
           fixed_cleaning = $6,
           fixed_other = $7,
           variable_expenses = $8,
           variable_notes = $9,
           total_expenses = $10,
           capital_reserve = $11,
           bad_debt_provision = $12,
           total_provisions = $13,
           grand_total = $14,
           notes = $15,
           updated_by = $16
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id, data.month, data.year,
        fixedMaintenance, fixedSecurity, fixedCleaning, fixedOther,
        variableTotal, data.variableNotes || null, totalExpenses,
        totalProvisions, 0, totalProvisions, grandTotal,
        data.notes || null, req.user.id,
      ]
    );

    await client.query('DELETE FROM condo_period_expense_items WHERE period_id = $1', [req.params.id]);
    await client.query(
      `DELETE FROM condo_fund_entries
       WHERE period_id = $1 AND entry_type = 'PROVISION'`,
      [req.params.id]
    );

    for (const item of snapshotItems) {
      await client.query(
        `INSERT INTO condo_period_expense_items
           (id, period_id, expense_item_id, name, category, expense_type, amount, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [newId(), req.params.id, item.expenseItemId, item.name, item.category, item.expenseType, item.amount, req.user.id]
      );
    }

    for (const p of provisionResults) {
      if (p.calculatedAmount <= 0) continue;
      await client.query(
        `INSERT INTO condo_fund_entries
           (id, fund_type, provision_id, amount, entry_type, period_id, description, registered_by, created_by, updated_by)
         VALUES ($1,'PROVISION',$2,$3,'PROVISION',$4,$5,$6,$6,$6)`,
        [newId(), p.id, p.calculatedAmount, req.params.id,
         `Provisión ${p.name} — Período ${data.month}/${data.year}`, req.user.id]
      );
    }

    await client.query('COMMIT');
    success(res, rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /condominium/periods/:id/expense-items — ítems de gasto del período
router.get('/periods/:id/expense-items', async (req, res) => {
  const { rows } = await query(
    `SELECT id, expense_item_id AS "expenseItemId", name, category,
            expense_type AS "expenseType", amount::float, notes, created_at AS "createdAt"
     FROM condo_period_expense_items
     WHERE period_id = $1
     ORDER BY expense_type DESC, amount DESC`,
    [req.params.id]
  );
  success(res, rows);
});

// POST /condominium/periods/:id/generate — generar alícuotas
router.post('/periods/:id/generate', authorize('ADMIN'), async (req, res) => {
  const periodRes = await query('SELECT * FROM condo_expense_periods WHERE id = $1', [req.params.id]);
  const period = periodRes.rows[0];
  if (!period) throw new AppError('Período no encontrado', 404);
  if (period.status !== 'DRAFT') throw new AppError('Solo se pueden generar alícuotas desde un período en borrador', 400);

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
      // Usar grand_total si existe (períodos con provisiones), si no total_expenses (retrocompat)
      const base = parseFloat(period.grand_total) > 0
        ? parseFloat(period.grand_total)
        : parseFloat(period.total_expenses);
      const aliquotAmount = Math.round(
        base * parseFloat(owner.participation_pct) / 100 * 100
      ) / 100;

      await client.query(
        `INSERT INTO aliquot_payments
           (id, period_id, owner_id, aliquot_amount, mora_at_billing, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (period_id, owner_id) DO UPDATE SET
           aliquot_amount = EXCLUDED.aliquot_amount,
           mora_at_billing = EXCLUDED.mora_at_billing,
           updated_by = EXCLUDED.updated_by`,
        // La mora pertenece al saldo del propietario; no se factura de nuevo
        // dentro de la alícuota mensual.
        [newId(), period.id, owner.id, aliquotAmount, 0, req.user.id]
      );
    }

    await client.query(
      `UPDATE condo_expense_periods SET status = 'APPROVED', generated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [req.user.id, period.id]
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
  const totalRes = await query(
    `SELECT COUNT(*)::int AS total
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     WHERE ap.period_id = $1
       AND ap.status IN ('PENDING', 'PARTIAL', 'OVERDUE')`,
    [req.params.id]
  );

  const { rows } = await query(
    `SELECT ap.*, o.name AS owner_name, o.email AS owner_email, o.unit_number,
            o.participation_pct, o.mora_amount::float AS owner_mora_amount,
            cep.month, cep.year, cep.total_expenses,
            cep.total_provisions, cep.grand_total
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE ap.period_id = $1 AND o.email IS NOT NULL
       AND ap.status IN ('PENDING', 'PARTIAL', 'OVERDUE')`,
    [req.params.id]
  );

  let sent = 0;
  const sharedPeriodPdfs = rows.length
    ? {
        periodSummaryData: await getPeriodSummaryPdfData(rows[0].period_id),
        previousBalancePdf: await buildBalancePdfBuffer(previousMonthOf(rows[0].year, rows[0].month)),
      }
    : null;
  for (const payment of rows) {
    await sendAliquotEmail(payment, await buildAliquotEmailAttachments(payment, sharedPeriodPdfs));
    sent++;
  }
  success(res, {
    sent,
    total: totalRes.rows[0]?.total || rows.length,
    skippedWithoutEmail: Math.max(0, (totalRes.rows[0]?.total || rows.length) - rows.length),
  }, 200, `Emails enviados: ${sent}`);
});

// POST /condominium/periods/:id/payments/:paymentId/send-email
// Enviar correo de cobro a un solo propietario del período.
router.post('/periods/:id/payments/:paymentId/send-email', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    `SELECT ap.*, o.name AS owner_name, o.email AS owner_email, o.unit_number,
            o.participation_pct, o.mora_amount::float AS owner_mora_amount,
            cep.month, cep.year, cep.total_expenses,
            cep.total_provisions, cep.grand_total
     FROM aliquot_payments ap
     JOIN condo_owners o ON o.id = ap.owner_id
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE ap.period_id = $1
       AND ap.id = $2
       AND ap.status IN ('PENDING', 'PARTIAL', 'OVERDUE')`,
    [req.params.id, req.params.paymentId]
  );

  const payment = rows[0];
  if (!payment) throw new AppError('Alícuota del período no encontrada o ya pagada', 404);
  if (!payment.owner_email) throw new AppError('El propietario no tiene correo registrado', 400);

  await sendAliquotEmail(payment, await buildAliquotEmailAttachments(payment));
  success(res, {
    sent: 1,
    paymentId: payment.id,
    ownerEmail: payment.owner_email,
    ownerName: payment.owner_name,
    unitNumber: payment.unit_number,
  }, 200, 'Email enviado');
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

    // Solo el saldo generado por este período se convierte en mora. La mora
    // histórica es un saldo del propietario, no puede volver a sumarse aquí.
    const unpaidRes = await client.query(
      `SELECT ap.*, COALESCE((
         SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
       ), 0)::float AS extras_total
       FROM aliquot_payments ap
       WHERE ap.period_id = $1 AND ap.status IN ('PENDING', 'PARTIAL')`,
      [period.id]
    );

    for (const ap of unpaidRes.rows) {
      const periodDue = parseFloat(ap.aliquot_amount) + ap.extras_total;
      const pending = Math.max(0, periodDue - parseFloat(ap.paid_amount));
      await client.query(
        `UPDATE aliquot_payments SET status = $1, updated_by = $2 WHERE id = $3`,
        [pending > 0.01 ? 'OVERDUE' : 'PAID', req.user.id, ap.id]
      );
      if (pending > 0.01) {
        await client.query(
          `UPDATE condo_owners SET mora_amount = mora_amount + $1, updated_by = $2 WHERE id = $3`,
          [pending, req.user.id, ap.owner_id]
        );
      }
    }

    await client.query(
      `UPDATE condo_expense_periods SET status = 'CLOSED', closed_at = NOW(), updated_by = $1 WHERE id = $2`,
      [req.user.id, period.id]
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

// DELETE /condominium/periods/:id — eliminar período y todos sus registros
router.delete('/periods/:id', authorize('ADMIN'), async (req, res) => {
  const periodRes = await query('SELECT * FROM condo_expense_periods WHERE id = $1', [req.params.id]);
  const period = periodRes.rows[0];
  if (!period) throw new AppError('Período no encontrado', 404);
  if (period.status === 'CLOSED') throw new AppError('No se puede eliminar un período cerrado', 400);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 1. Conservar las referencias para limpiar después del COMMIT. Un mismo
    // PDF de movimientos puede estar asociado a más de una alícuota.
    const proofsRes = await client.query(
      `SELECT proof_public_id FROM aliquot_payments WHERE period_id = $1 AND proof_public_id IS NOT NULL
       UNION
       SELECT proof_public_id FROM aliquot_payment_records WHERE period_id = $1 AND proof_public_id IS NOT NULL`,
      [period.id]
    );
    const proofPublicIds = [...new Set(proofsRes.rows.map((row) => row.proof_public_id))];

    // 2. Revertir mora acumulada en propietarios por pagos OVERDUE de este período
    const overdueRes = await client.query(
      `SELECT ap.owner_id,
              GREATEST(0, ap.aliquot_amount + COALESCE((
                SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
              ), 0) - ap.paid_amount)::numeric AS pending
       FROM aliquot_payments ap
       WHERE ap.period_id = $1 AND ap.status = 'OVERDUE'`,
      [period.id]
    );
    for (const row of overdueRes.rows) {
      await client.query(
        `UPDATE condo_owners SET mora_amount = GREATEST(0, mora_amount - $1), updated_by = $2 WHERE id = $3`,
        [row.pending, req.user.id, row.owner_id]
      );
    }

    // 3. Eliminar registros relacionados en orden de dependencia
    await client.query('DELETE FROM aliquot_payment_records WHERE period_id = $1', [period.id]);
    await client.query('DELETE FROM aliquot_payments         WHERE period_id = $1', [period.id]);
    await client.query('DELETE FROM condo_period_expense_items WHERE period_id = $1', [period.id]);
    await client.query('DELETE FROM condo_fund_entries        WHERE period_id = $1', [period.id]);
    await client.query('DELETE FROM condo_expense_periods     WHERE id = $1',        [period.id]);

    await client.query('COMMIT');
    for (const publicId of proofPublicIds) {
      try { await deleteProofIfUnreferenced(publicId); } catch (_) { /* best-effort */ }
    }
    success(res, null, 200, 'Período eliminado');
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

  const apRes = await query(
    `SELECT ap.*, cep.status AS period_status, o.mora_amount::float AS owner_mora_amount
     FROM aliquot_payments ap
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     JOIN condo_owners o ON o.id = ap.owner_id
     WHERE ap.id = $1`,
    [req.params.paymentId]
  );
  const ap = apRes.rows[0];
  if (!ap) throw new AppError('Pago no encontrado', 404);
  if (ap.status === 'PAID') throw new AppError('Ya fue pagado en su totalidad', 400);

  const total = parseFloat(ap.aliquot_amount) + (await query(
    'SELECT COALESCE(SUM(amount),0)::float AS t FROM aliquot_payment_extras WHERE payment_id = $1',
    [ap.id]
  )).rows[0].t;
  const periodPending = Math.max(0, total - parseFloat(ap.paid_amount));
  const moraAvailable = ap.owner_mora_amount;
  const periodClosed = ap.period_status === 'CLOSED';
  const maxAllowed = periodClosed ? moraAvailable : periodPending + moraAvailable;
  if (paidAmount > maxAllowed + 0.01) {
    const limitLabel = periodClosed ? 'mora disponible' : 'saldo del período y la mora disponible';
    throw new AppError(`El valor excede ${limitLabel} ($${maxAllowed.toFixed(2)})`, 400);
  }
  // En períodos cerrados no se registran abonos nuevos al período; todo pago
  // debe entrar como abono a la mora acumulada. En períodos abiertos, la mora
  // histórica conserva prioridad y solo el remanente va al período actual.
  const amountForMora = periodClosed ? paidAmount : Math.min(paidAmount, moraAvailable);
  const amountForPeriod = periodClosed ? 0 : Math.min(Math.max(0, paidAmount - amountForMora), periodPending);
  const newPaid = parseFloat(ap.paid_amount) + amountForPeriod;
  const status  = newPaid >= total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : ap.status;
  const paymentNotes = [
    notes || null,
    amountForMora > 0 ? `Pago aplicado prioritariamente a mora: $${amountForMora.toFixed(2)}` : null,
  ].filter(Boolean).join('\n') || null;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    let rows;
    if (periodClosed) {
      const updateRes = await client.query(
        `UPDATE aliquot_payments SET notes = $1, registered_by = $2, updated_by = $2
         WHERE id = $3 RETURNING *`,
        [paymentNotes, req.user.id, ap.id]
      );
      rows = updateRes.rows;
    } else {
      const updateRes = await client.query(
        `UPDATE aliquot_payments SET
           paid_amount = $1,
           payment_date = CASE WHEN $2::numeric > 0 THEN $3 ELSE payment_date END,
           status = $4, notes = $5, registered_by = $6, updated_by = $6
         WHERE id = $7 RETURNING *`,
        [newPaid, amountForPeriod, paymentDate, status, paymentNotes, req.user.id, ap.id]
      );
      rows = updateRes.rows;
    }
    let moraPaymentRecordIds = [];
    if (amountForMora > 0) {
      moraPaymentRecordIds = await applyMoraPayment(client, {
        ownerId: ap.owner_id, amount: amountForMora, paymentDate,
        paymentType: 'ALIQUOT_EXCESS', sourceAliquotPaymentId: ap.id,
        notes: 'Pago de alícuota aplicado prioritariamente a mora.', registeredBy: req.user.id,
      });
      if (periodClosed) {
        const refreshed = await client.query('SELECT * FROM aliquot_payments WHERE id = $1', [ap.id]);
        rows = refreshed.rows;
      }
    }
    const paymentRecordId = await createAliquotPaymentRecord(client, {
      paymentId: ap.id,
      ownerId: ap.owner_id,
      periodId: ap.period_id,
      amount: paidAmount,
      amountForPeriod,
      amountForMora,
      paymentDate,
      notes: paymentNotes,
      sourceType: 'MANUAL',
      registeredBy: req.user.id,
    });
    await client.query('COMMIT');
    success(res, { ...rows[0], moraPaymentRecordIds, paymentRecordId }, 200, `Pago registrado (${status})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /condominium/payments/:paymentId/ocr-confirm
// Confirma una coincidencia previamente revisada: guarda el comprobante en el
// bucket y registra el valor contra la alícuota del mismo período.
router.post('/payments/:paymentId/ocr-confirm', authorize('ADMIN'), uploadSingle, async (req, res) => {
  const data = z.object({
    amount:        z.coerce.number().positive(),
    paymentDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de pago inválida'),
    ocrSenderName: z.string().max(200).optional(),
    ocrBank:       z.string().max(200).optional(),
    movementProofUrl: z.string().url().optional(),
    movementProofPublicId: z.string().min(1).optional(),
  }).refine(
    (value) => Boolean(value.movementProofUrl) === Boolean(value.movementProofPublicId),
    { message: 'La referencia al PDF de movimientos está incompleta' }
  ).parse(req.body);

  const sharedMovementProof = !!data.movementProofUrl && !!data.movementProofPublicId;
  if (!req.file && !sharedMovementProof) throw new AppError('Comprobante requerido', 400);
  if (
    sharedMovementProof &&
    !data.movementProofPublicId.startsWith('habbita/condominio/movimientos/') &&
    !data.movementProofPublicId.startsWith('rrhh-admin/condominio/movimientos/')
  ) {
    throw new AppError('La referencia al PDF de movimientos no es válida', 400);
  }

  const apRes = await query(
    `SELECT ap.*, cep.month, cep.year, cep.status AS period_status,
            o.mora_amount::float AS owner_mora_amount
     FROM aliquot_payments ap
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     JOIN condo_owners o ON o.id = ap.owner_id
     WHERE ap.id = $1`,
    [req.params.paymentId]
  );
  const ap = apRes.rows[0];
  if (!ap) throw new AppError('Pago no encontrado', 404);
  if (ap.period_status === 'CLOSED') throw new AppError('El período está cerrado', 400);
  if (ap.status === 'PAID') throw new AppError('La alícuota ya está pagada', 400);

  const expectedMonth = `${ap.year}-${String(ap.month).padStart(2, '0')}`;
  // if (data.paymentDate.slice(0, 7) !== expectedMonth) {
  //   throw new AppError(`La fecha del comprobante no corresponde al período ${expectedMonth}`, 400);
  // }

  const extras = (await query(
    'SELECT COALESCE(SUM(amount), 0)::float AS total FROM aliquot_payment_extras WHERE payment_id = $1',
    [ap.id]
  )).rows[0].total;
  const totalDue = parseFloat(ap.aliquot_amount) + extras;
  const periodPending = Math.max(0, totalDue - parseFloat(ap.paid_amount));
  const moraAvailable = ap.owner_mora_amount;
  if (data.amount > periodPending + moraAvailable + 0.01) {
    throw new AppError(`El valor excede el saldo del período y la mora disponible ($${(periodPending + moraAvailable).toFixed(2)})`, 400);
  }
  // Mantener la misma regla que el registro manual: mora antigua primero,
  // después el período abierto al que se asignó el comprobante.
  const amountForMora = Math.min(data.amount, moraAvailable);
  const amountForPeriod = Math.min(Math.max(0, data.amount - amountForMora), periodPending);
  const newPaid = parseFloat(ap.paid_amount) + amountForPeriod;
  const status = newPaid >= totalDue ? 'PAID' : newPaid > 0 ? 'PARTIAL' : ap.status;

  const uploadedNewProof = !sharedMovementProof;
  const proof = sharedMovementProof
    ? { url: data.movementProofUrl, publicId: data.movementProofPublicId }
    : await uploadToCloudinary(
      req.file.buffer,
      `habbita/condominio/comprobantes/${expectedMonth}`,
      req.file.mimetype,
      req.file.originalname
    );
  const { url, publicId } = proof;
  const ocrNote = [
    `Comprobante OCR: ${req.file?.originalname || 'PDF de movimientos bancarios'}`,
    data.ocrSenderName ? `remitente ${data.ocrSenderName}` : null,
    data.ocrBank ? `banco ${data.ocrBank}` : null,
    amountForMora > 0 ? `pago aplicado prioritariamente a mora $${amountForMora.toFixed(2)}` : null,
  ].filter(Boolean).join(' — ');

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE aliquot_payments SET
         paid_amount = $1,
         payment_date = CASE WHEN $2::numeric > 0 THEN $3 ELSE payment_date END,
         status = $4, proof_url = $5, proof_public_id = $6, proof_uploaded_at = NOW(),
         notes = $7, registered_by = $8, updated_by = $8
       WHERE id = $9
       RETURNING *`,
      [newPaid, amountForPeriod, data.paymentDate, status, url, publicId,
       [ap.notes, ocrNote].filter(Boolean).join('\n'), req.user.id, ap.id]
    );

    if (amountForMora > 0) {
      await applyMoraPayment(client, {
        ownerId: ap.owner_id, amount: amountForMora, paymentDate: data.paymentDate,
        paymentType: 'ALIQUOT_EXCESS', sourceAliquotPaymentId: ap.id,
        proofUrl: url, proofPublicId: publicId,
        notes: 'Comprobante OCR aplicado prioritariamente a mora.', registeredBy: req.user.id,
      });
    }
    await createAliquotPaymentRecord(client, {
      paymentId: ap.id,
      ownerId: ap.owner_id,
      periodId: ap.period_id,
      amount: data.amount,
      amountForPeriod,
      amountForMora,
      paymentDate: data.paymentDate,
      proofUrl: url,
      proofPublicId: publicId,
      notes: ocrNote,
      sourceType: 'OCR',
      registeredBy: req.user.id,
    });

    await client.query('COMMIT');

    // No se elimina el comprobante anterior hasta que el nuevo ya quedó
    // persistido. Si Cloudinary falla al borrar, el pago nuevo sigue siendo válido.
    if (ap.proof_public_id && ap.proof_public_id !== publicId) {
      try { await deleteProofIfUnreferenced(ap.proof_public_id); } catch (_) { /* best-effort */ }
    }
    success(res, rows[0], 200, `Comprobante confirmado y pago registrado (${status})`);
  } catch (err) {
    await client.query('ROLLBACK');
    if (uploadedNewProof) {
      try { await deleteFromCloudinary(publicId); } catch (_) { /* best-effort */ }
    }
    throw err;
  } finally {
    client.release();
  }
});

// ── Extras por pago ────────────────────────────────────────────

// POST /condominium/payments/:paymentId/extras — agregar cargo extra
router.post('/payments/:paymentId/extras', authorize('ADMIN'), async (req, res) => {
  const { amount, notes } = z.object({
    amount: z.number().positive(),
    notes:  z.string().min(1).max(500),
  }).parse(req.body);

  const apRes = await query(
    `SELECT ap.id, ap.status, cep.status AS period_status
     FROM aliquot_payments ap
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE ap.id = $1`,
    [req.params.paymentId]
  );
  if (!apRes.rows[0]) throw new AppError('Pago no encontrado', 404);
  if (apRes.rows[0].period_status === 'CLOSED') throw new AppError('No se pueden agregar cargos extra a un período cerrado', 400);
  if (apRes.rows[0].status === 'PAID') throw new AppError('No se puede modificar un pago ya completado', 400);

  const { rows } = await query(
    `INSERT INTO aliquot_payment_extras (id, payment_id, amount, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING id, payment_id AS "paymentId", amount::float, notes, created_at AS "createdAt"`,
    [newId(), req.params.paymentId, amount, notes, req.user.id]
  );
  success(res, rows[0], 201, 'Cargo extra agregado');
});

// PATCH /condominium/extras/:extraId — editar cargo extra
router.patch('/extras/:extraId', authorize('ADMIN'), async (req, res) => {
  const { amount, notes } = z.object({
    amount: z.number().positive(),
    notes:  z.string().min(1).max(500),
  }).parse(req.body);

  const exRes = await query(
    `SELECT e.id, ap.status, cep.status AS period_status FROM aliquot_payment_extras e
     JOIN aliquot_payments ap ON ap.id = e.payment_id
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE e.id = $1`,
    [req.params.extraId]
  );
  if (!exRes.rows[0]) throw new AppError('Cargo extra no encontrado', 404);
  if (exRes.rows[0].period_status === 'CLOSED') throw new AppError('No se pueden editar cargos extra de un período cerrado', 400);
  if (exRes.rows[0].status === 'PAID') throw new AppError('No se puede modificar un pago ya completado', 400);

  const { rows } = await query(
    `UPDATE aliquot_payment_extras SET amount = $1, notes = $2, updated_by = $3
     WHERE id = $4
     RETURNING id, payment_id AS "paymentId", amount::float, notes, created_at AS "createdAt"`,
    [amount, notes, req.user.id, req.params.extraId]
  );
  success(res, rows[0], 200, 'Cargo extra actualizado');
});

// DELETE /condominium/extras/:extraId — eliminar cargo extra
router.delete('/extras/:extraId', authorize('ADMIN'), async (req, res) => {
  const exRes = await query(
    `SELECT e.id, ap.status, cep.status AS period_status FROM aliquot_payment_extras e
     JOIN aliquot_payments ap ON ap.id = e.payment_id
     JOIN condo_expense_periods cep ON cep.id = ap.period_id
     WHERE e.id = $1`,
    [req.params.extraId]
  );
  if (!exRes.rows[0]) throw new AppError('Cargo extra no encontrado', 404);
  if (exRes.rows[0].period_status === 'CLOSED') throw new AppError('No se pueden eliminar cargos extra de un período cerrado', 400);
  if (exRes.rows[0].status === 'PAID') throw new AppError('No se puede eliminar un cargo de un pago ya completado', 400);

  await query('DELETE FROM aliquot_payment_extras WHERE id = $1', [req.params.extraId]);
  success(res, null, 200, 'Cargo extra eliminado');
});

// POST /condominium/payments/:paymentId/proof — subir comprobante
router.post('/payments/:paymentId/proof', authorize('ADMIN'), uploadSingle, async (req, res) => {
  if (!req.file) throw new AppError('Archivo requerido', 400);

  const apRes = await query('SELECT * FROM aliquot_payments WHERE id = $1', [req.params.paymentId]);
  const ap = apRes.rows[0];
  if (!ap) throw new AppError('Pago no encontrado', 404);

  let moraPaymentRecordIds = [];
  let paymentRecordId = null;
  try {
    moraPaymentRecordIds = req.body.moraPaymentRecordIds ? JSON.parse(req.body.moraPaymentRecordIds) :
      (req.body.moraPaymentRecordId ? [req.body.moraPaymentRecordId] : []);
    paymentRecordId = req.body.paymentRecordId || null;
  } catch (_) {
    throw new AppError('Registros de abono a mora inválidos', 400);
  }
  if (!Array.isArray(moraPaymentRecordIds) || !moraPaymentRecordIds.every(id => typeof id === 'string')) {
    throw new AppError('Registros de abono a mora inválidos', 400);
  }
  if (paymentRecordId && typeof paymentRecordId !== 'string') {
    throw new AppError('Registro de pago inválido', 400);
  }
  if (paymentRecordId) {
    const recordRes = await query(
      'SELECT id FROM aliquot_payment_records WHERE id = $1 AND payment_id = $2',
      [paymentRecordId, ap.id]
    );
    if (!recordRes.rows[0]) throw new AppError('Registro de pago no encontrado', 404);
  }
  if (moraPaymentRecordIds.length) {
    const recordRes = await query(
      'SELECT id FROM mora_payment_records WHERE id = ANY($1) AND aliquot_payment_id = $2',
      [moraPaymentRecordIds, ap.id]
    );
    if (recordRes.rows.length !== moraPaymentRecordIds.length) {
      throw new AppError('Registro de abono a mora no encontrado', 404);
    }
  }

  const month = String(ap.created_at).slice(0, 7);
  const folder = `habbita/condominio/comprobantes/${month}`;
  const { url, publicId } = await uploadToCloudinary(
    req.file.buffer, folder, req.file.mimetype, req.file.originalname
  );

  const newStatus = ap.status === 'PENDING' && parseFloat(ap.paid_amount) > 0.01 ? 'PARTIAL' : ap.status;

  const { rows } = await query(
    `UPDATE aliquot_payments SET
       proof_url = $1, proof_public_id = $2, proof_uploaded_at = NOW(), status = $3,
       updated_by = $4
     WHERE id = $5 RETURNING *`,
    [url, publicId, newStatus, req.user.id, ap.id]
  );

  if (moraPaymentRecordIds.length) {
    await query(
      `UPDATE mora_payment_records SET proof_url = $1, proof_public_id = $2, updated_by = $3
       WHERE id = ANY($4)`,
      [url, publicId, req.user.id, moraPaymentRecordIds]
    );
  }
  if (paymentRecordId) {
    await query(
      `UPDATE aliquot_payment_records SET proof_url = $1, proof_public_id = $2, updated_by = $3
       WHERE id = $4`,
      [url, publicId, req.user.id, paymentRecordId]
    );
  }

  if (ap.proof_public_id && ap.proof_public_id !== publicId) {
    try { await deleteProofIfUnreferenced(ap.proof_public_id); } catch (_) { /* best-effort */ }
  }

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

  await query(
    `UPDATE aliquot_payments SET proof_url = NULL, proof_public_id = NULL, proof_uploaded_at = NULL,
     updated_by = $1
     WHERE id = $2`,
    [req.user.id, req.params.paymentId]
  );
  try { await deleteProofIfUnreferenced(ap.proof_public_id); } catch (_) { /* best-effort */ }
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

  const pdfBuffer = await generateAliquotPdf({ ...rows[0], extras: await getPaymentExtras(rows[0].id) });
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
       COALESCE((
         SELECT COUNT(*)::int
         FROM aliquot_payments ap
         WHERE ap.owner_id = o.id AND ap.status = 'OVERDUE'
       ), 0)                AS "overduePeriods",
       COALESCE((
         SELECT JSON_AGG(debt ORDER BY debt.year DESC, debt.month DESC)
         FROM (
           SELECT
             cep.id                         AS "periodId",
             ap.id                          AS "paymentId",
             cep.month,
             cep.year,
             cep.closed_at                  AS "closedAt",
             ap.aliquot_amount::float       AS "aliquotAmount",
             COALESCE((
               SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
             ), 0)::float                   AS "extrasTotal",
             ap.paid_amount::float          AS "amountPaid",
             GREATEST(0, ap.aliquot_amount + COALESCE((
               SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
             ), 0) - ap.paid_amount)::float AS "pendingAmount"
           FROM aliquot_payments ap
           JOIN condo_expense_periods cep ON cep.id = ap.period_id
           WHERE ap.owner_id = o.id AND ap.status = 'OVERDUE'
         ) debt
       ), '[]'::json)       AS "debtPeriods"
       , COALESCE((
         SELECT JSON_AGG(mora_payment ORDER BY mora_payment."paymentDate" DESC, mora_payment."createdAt" DESC)
         FROM (
           SELECT mr.id, mr.debt_payment_id AS "debtPaymentId", mr.amount::float,
                  mr.payment_date AS "paymentDate", mr.payment_type AS "paymentType",
                  mr.proof_url AS "proofUrl", mr.notes, mr.created_at AS "createdAt",
                  debt_period.month AS "debtMonth", debt_period.year AS "debtYear",
                  (debt_payment.aliquot_amount + COALESCE((
                    SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = debt_payment.id
                  ), 0))::float AS "debtTotalAmount",
                  GREATEST(0, debt_payment.aliquot_amount + COALESCE((
                    SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = debt_payment.id
                  ), 0) - debt_payment.paid_amount)::float AS "debtCurrentPending"
           FROM mora_payment_records mr
           LEFT JOIN aliquot_payments debt_payment ON debt_payment.id = mr.debt_payment_id
           LEFT JOIN condo_expense_periods debt_period ON debt_period.id = debt_payment.period_id
           WHERE mr.owner_id = o.id
         ) mora_payment
       ), '[]'::json)       AS "moraPayments"
     FROM condo_owners o
     WHERE o.mora_amount > 0 OR EXISTS (
       SELECT 1 FROM aliquot_payments ap WHERE ap.owner_id = o.id AND ap.status = 'OVERDUE'
     ) OR EXISTS (
       SELECT 1 FROM mora_payment_records mr WHERE mr.owner_id = o.id
     )
     ORDER BY o.mora_amount DESC`
  );
  success(res, rows);
};
router.get('/morosidad',         morosidadHandler);
router.get('/reports/morosidad', morosidadHandler);

// ── Fondos de Reserva ─────────────────────────────────────────

// GET /condominium/funds/summary — saldo actual por provisión
router.get('/funds/summary', async (_req, res) => {
  const catalogRes = await query(
    `SELECT * FROM provision_catalog ORDER BY sort_order, created_at`
  );
  const balancesRes = await query(
    `SELECT provision_id, COALESCE(SUM(amount), 0)::float AS balance
     FROM condo_fund_entries WHERE provision_id IS NOT NULL
     GROUP BY provision_id`
  );
  const balanceMap = {};
  for (const r of balancesRes.rows) balanceMap[r.provision_id] = parseFloat(r.balance);

  const recentRes = await query(
    `SELECT fe.*, pc.name AS provision_name
     FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY provision_id ORDER BY entry_date DESC, created_at DESC) AS rn
       FROM condo_fund_entries WHERE provision_id IS NOT NULL
     ) fe
     LEFT JOIN provision_catalog pc ON pc.id = fe.provision_id
     WHERE fe.rn <= 5 ORDER BY fe.provision_id, fe.entry_date DESC`
  );

  const result = {};
  for (const p of catalogRes.rows) {
    result[p.id] = {
      id: p.id, name: p.name, is_active: p.is_active,
      balance: balanceMap[p.id] || 0,
      last_entries: recentRes.rows.filter(r => r.provision_id === p.id),
    };
  }
  success(res, result);
});

// GET /condominium/fund-entries — historial paginado del libro auxiliar
router.get('/fund-entries', async (req, res) => {
  const { provision_id, limit = 100, offset = 0 } = req.query;

  // Calcular running balance en orden cronológico
  const allRes = await query(
    `SELECT id, provision_id, amount FROM condo_fund_entries
     ${provision_id ? 'WHERE provision_id = $1' : ''}
     ORDER BY entry_date ASC, created_at ASC`,
    provision_id ? [provision_id] : []
  );
  const cumMap = {};
  let running = 0;
  for (const r of allRes.rows) {
    running += parseFloat(r.amount);
    cumMap[r.id] = Math.round(running * 100) / 100;
  }

  const params = provision_id
    ? [provision_id, parseInt(limit), parseInt(offset)]
    : [parseInt(limit), parseInt(offset)];
  const { rows } = await query(
    `SELECT fe.*, u.email AS registered_by_email, pc.name AS provision_name
     FROM condo_fund_entries fe
     LEFT JOIN users u ON u.id = fe.registered_by
     LEFT JOIN provision_catalog pc ON pc.id = fe.provision_id
     ${provision_id ? 'WHERE fe.provision_id = $1' : ''}
     ORDER BY fe.entry_date DESC, fe.created_at DESC
     LIMIT $${provision_id ? 2 : 1} OFFSET $${provision_id ? 3 : 2}`,
    params
  );

  success(res, rows.map(r => ({ ...r, running_balance: cumMap[r.id] ?? null })));
});

// POST /condominium/fund-entries — registrar egreso / ajuste / reversión
router.post('/fund-entries', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    provision_id: z.string(),
    amount:       z.number().positive(),
    entry_type:   z.enum(['EXPENDITURE', 'WRITE_OFF', 'ADJUSTMENT', 'REVERSAL']),
    description:  z.string().min(3),
    entry_date:   z.string().optional(),
    is_negative:  z.boolean().default(true),
  }).parse(req.body);

  const provRes = await query('SELECT id FROM provision_catalog WHERE id = $1', [data.provision_id]);
  if (!provRes.rows.length) throw new AppError('Provisión no encontrada', 404);

  let amount = data.amount;
  if (['EXPENDITURE', 'WRITE_OFF'].includes(data.entry_type)) amount = -data.amount;
  else if (data.entry_type === 'ADJUSTMENT' && data.is_negative) amount = -data.amount;

  const { rows } = await query(
    `INSERT INTO condo_fund_entries
       (id, fund_type, provision_id, amount, entry_type, description, entry_date, registered_by, created_by, updated_by)
     VALUES ($1,'PROVISION',$2,$3,$4,$5,$6,$7,$7,$7) RETURNING *`,
    [newId(), data.provision_id, amount, data.entry_type,
     data.description, data.entry_date || null, req.user.id]
  );
  success(res, rows[0], 201);
});

// ── Libro de Ingresos y Egresos ───────────────────────────────

// GET /condominium/reports/balance
router.get('/reports/balance', async (req, res) => {
  const { year, month_from, month_to } = req.query;

  const conditions = [];
  const params = [];
  if (year)       { params.push(parseInt(year));       conditions.push(`cep.year = $${params.length}`); }
  if (month_from) { params.push(parseInt(month_from)); conditions.push(`cep.month >= $${params.length}`); }
  if (month_to)   { params.push(parseInt(month_to));   conditions.push(`cep.month <= $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const periodsRes = await query(
    `SELECT cep.*,
            COUNT(ap.id)::int AS total_payments,
            SUM(CASE WHEN ap.status = 'PAID' THEN 1 ELSE 0 END)::int AS paid_count,
            COALESCE(SUM(CASE WHEN ap.status = 'PAID' THEN ap.paid_amount ELSE 0 END), 0) AS total_collected,
            COALESCE(SUM(ap.aliquot_amount + COALESCE((
              SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
            ), 0)), 0) AS total_billed
     FROM condo_expense_periods cep
     LEFT JOIN aliquot_payments ap ON ap.period_id = cep.id
     ${where}
     GROUP BY cep.id
     ORDER BY cep.year ASC, cep.month ASC`,
    params
  );

  const periodIds = periodsRes.rows.map(p => p.id);
  let expenseItems = [], periodFundEntries = [];
  if (periodIds.length > 0) {
    const [itemsRes, fundRes] = await Promise.all([
      query(`SELECT * FROM condo_period_expense_items WHERE period_id = ANY($1) ORDER BY created_at`, [periodIds]),
      query(`SELECT fe.*, pc.name AS provision_name
             FROM condo_fund_entries fe
             LEFT JOIN provision_catalog pc ON pc.id = fe.provision_id
             WHERE fe.period_id = ANY($1) ORDER BY fe.entry_date ASC`, [periodIds]),
    ]);
    expenseItems       = itemsRes.rows;
    periodFundEntries  = fundRes.rows;
  }

  const adminConditions = [];
  const adminParams = [];
  if (year) {
    adminParams.push(parseInt(year, 10));
    adminConditions.push(`EXTRACT(YEAR FROM ae.expense_date)::int = $${adminParams.length}`);
  }
  if (month_from) {
    adminParams.push(parseInt(month_from, 10));
    adminConditions.push(`EXTRACT(MONTH FROM ae.expense_date)::int >= $${adminParams.length}`);
  }
  if (month_to) {
    adminParams.push(parseInt(month_to, 10));
    adminConditions.push(`EXTRACT(MONTH FROM ae.expense_date)::int <= $${adminParams.length}`);
  }
  const adminWhere = adminConditions.length ? `WHERE ${adminConditions.join(' AND ')}` : '';
  const adminExpensesRes = await query(
    `SELECT id, expense_date::text AS "expenseDate",
            EXTRACT(YEAR FROM expense_date)::int AS year,
            EXTRACT(MONTH FROM expense_date)::int AS month,
            expense_type AS "expenseType", category, vendor, description,
            amount::float AS amount, receipt_url AS "receiptUrl"
     FROM condo_admin_expenses ae
     ${adminWhere}
     ORDER BY expense_date ASC, created_at ASC`,
    adminParams
  );

  const fundsRes = await query(
    `SELECT pc.id, pc.name, COALESCE(SUM(fe.amount), 0)::float AS balance
     FROM provision_catalog pc
     LEFT JOIN condo_fund_entries fe ON fe.provision_id = pc.id
     GROUP BY pc.id, pc.name ORDER BY pc.sort_order`
  );
  const fundBalances = {};
  for (const r of fundsRes.rows) fundBalances[r.id] = { name: r.name, balance: parseFloat(r.balance) };

  let cumulative = 0;
  const rows = periodsRes.rows.map(period => {
    const items     = expenseItems.filter(i => i.period_id === period.id);
    const fundMoves = periodFundEntries.filter(e => e.period_id === period.id && e.entry_type !== 'PROVISION');
    const adminItems = adminExpensesRes.rows.filter(e => e.year === period.year && e.month === period.month);

    const total_billed       = parseFloat(period.total_billed) || 0;
    const total_collected    = parseFloat(period.total_collected) || 0;
    const total_expenses     = parseFloat(period.total_expenses) || 0;
    const total_admin_expenses = adminItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const total_operating_expenses = Math.round((total_expenses + total_admin_expenses) * 100) / 100;
    const total_provisions   = parseFloat(period.total_provisions) || 0;
    const grand_total        = parseFloat(period.grand_total) > 0 ? parseFloat(period.grand_total) : total_expenses;
    const balance = Math.round((total_collected - total_operating_expenses) * 100) / 100;
    cumulative = Math.round((cumulative + balance) * 100) / 100;

    // Provisiones de este período desde condo_fund_entries
    const periodProvisions = periodFundEntries
      .filter(e => e.period_id === period.id && e.entry_type === 'PROVISION')
      .map(e => ({ provision_id: e.provision_id, name: e.provision_name || e.fund_type, amount: parseFloat(e.amount) }));

    return {
      period: { id: period.id, month: period.month, year: period.year, status: period.status, generated_at: period.generated_at },
      ingresos: {
        total_billed, total_collected,
        total_payments: period.total_payments || 0,
        paid_count: period.paid_count || 0,
        collection_pct: total_billed > 0 ? Math.round(total_collected / total_billed * 100) : 0,
      },
      egresos: {
        items: items.map(i => ({ name: i.name, category: i.category, expense_type: i.expense_type, amount: parseFloat(i.amount) })),
        provisions: periodProvisions,
        admin_items: adminItems,
        total_admin_expenses,
        total_operating_expenses,
        total_expenses, total_provisions, grand_total,
      },
      fund_moves: fundMoves,
      balance,
      cumulative,
    };
  });

  const summary = rows.reduce((acc, r) => ({
    total_billed:     acc.total_billed     + r.ingresos.total_billed,
    total_collected:  acc.total_collected  + r.ingresos.total_collected,
    total_expenses:   acc.total_expenses   + r.egresos.total_expenses,
    total_admin_expenses: acc.total_admin_expenses + (r.egresos.total_admin_expenses || 0),
    total_operating_expenses: acc.total_operating_expenses + (r.egresos.total_operating_expenses || r.egresos.total_expenses),
    total_provisions: acc.total_provisions + r.egresos.total_provisions,
    grand_total:      acc.grand_total      + r.egresos.grand_total,
    net_result:       acc.net_result       + r.balance,
  }), { total_billed: 0, total_collected: 0, total_expenses: 0, total_admin_expenses: 0, total_operating_expenses: 0, total_provisions: 0, grand_total: 0, net_result: 0 });

  success(res, { rows, summary, funds: fundBalances });
});

// GET /condominium/reports/balance/pdf
router.get('/reports/balance/pdf', async (req, res) => {
  const { year, month_from, month_to } = req.query;

  // Reutilizar la misma lógica del balance
  const conditions = [];
  const params = [];
  if (year)       { params.push(parseInt(year));       conditions.push(`cep.year = $${params.length}`); }
  if (month_from) { params.push(parseInt(month_from)); conditions.push(`cep.month >= $${params.length}`); }
  if (month_to)   { params.push(parseInt(month_to));   conditions.push(`cep.month <= $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const periodsRes = await query(
    `SELECT cep.*,
            COALESCE(SUM(CASE WHEN ap.status = 'PAID' THEN ap.paid_amount ELSE 0 END), 0) AS total_collected,
            COALESCE(SUM(ap.aliquot_amount + COALESCE((
              SELECT SUM(e.amount) FROM aliquot_payment_extras e WHERE e.payment_id = ap.id
            ), 0)), 0) AS total_billed
     FROM condo_expense_periods cep
     LEFT JOIN aliquot_payments ap ON ap.period_id = cep.id
     ${where}
     GROUP BY cep.id
     ORDER BY cep.year ASC, cep.month ASC`,
    params
  );

  const periodIds = periodsRes.rows.map(p => p.id);
  let expenseItems = [], periodProvisions = [];
  if (periodIds.length > 0) {
    const [itemsRes, provisionsRes] = await Promise.all([
      query(
        `SELECT period_id, name, category, expense_type, amount::float AS amount
         FROM condo_period_expense_items
         WHERE period_id = ANY($1)
         ORDER BY created_at`,
        [periodIds]
      ),
      query(
        `SELECT fe.period_id, fe.provision_id, COALESCE(pc.name, fe.fund_type) AS name,
                fe.amount::float AS amount
         FROM condo_fund_entries fe
         LEFT JOIN provision_catalog pc ON pc.id = fe.provision_id
         WHERE fe.period_id = ANY($1) AND fe.entry_type = 'PROVISION'
         ORDER BY fe.entry_date ASC`,
        [periodIds]
      ),
    ]);
    expenseItems = itemsRes.rows;
    periodProvisions = provisionsRes.rows;
  }

  const adminConditions = [];
  const adminParams = [];
  if (year) {
    adminParams.push(parseInt(year, 10));
    adminConditions.push(`EXTRACT(YEAR FROM ae.expense_date)::int = $${adminParams.length}`);
  }
  if (month_from) {
    adminParams.push(parseInt(month_from, 10));
    adminConditions.push(`EXTRACT(MONTH FROM ae.expense_date)::int >= $${adminParams.length}`);
  }
  if (month_to) {
    adminParams.push(parseInt(month_to, 10));
    adminConditions.push(`EXTRACT(MONTH FROM ae.expense_date)::int <= $${adminParams.length}`);
  }
  const adminWhere = adminConditions.length ? `WHERE ${adminConditions.join(' AND ')}` : '';
  const adminExpensesRes = await query(
    `SELECT id, expense_date::text AS "expenseDate",
            EXTRACT(YEAR FROM expense_date)::int AS year,
            EXTRACT(MONTH FROM expense_date)::int AS month,
            expense_type AS "expenseType", category, vendor, description,
            amount::float AS amount
     FROM condo_admin_expenses ae
     ${adminWhere}
     ORDER BY expense_date ASC, created_at ASC`,
    adminParams
  );

  const periods = periodsRes.rows.map(period => ({
    ...period,
    expense_items: expenseItems.filter(item => item.period_id === period.id),
    provisions: periodProvisions.filter(provision => provision.period_id === period.id),
    admin_expenses: adminExpensesRes.rows.filter(expense => expense.year === period.year && expense.month === period.month),
  }));

  const moraRes = await query(
    `SELECT COALESCE(SUM(mora_amount), 0)::float AS total_mora FROM condo_owners WHERE mora_amount > 0`
  );
  const totalMora = parseFloat(moraRes.rows[0]?.total_mora) || 0;

  const cfgRes = await query('SELECT name FROM condo_config LIMIT 1');
  const condoName = cfgRes.rows[0]?.name || 'Condominio';

  const buf = await generateBalancePdf({ condoName, periods, totalMora, year, month_from, month_to });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="balance-${year || 'todo'}.pdf"`);
  res.send(buf);
});

module.exports = router;
