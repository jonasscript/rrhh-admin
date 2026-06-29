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
const { generateAliquotPdf, generateBalancePdf } = require('../../services/pdf.service');
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
      'UPDATE aliquot_payments SET paid_amount = $1, status = $2 WHERE id = $3',
      [newPaid, debtStatus, debt.id]
    );

    const recordId = newId();
    await client.query(
      `INSERT INTO mora_payment_records
         (id, owner_id, debt_payment_id, aliquot_payment_id, amount, payment_date, payment_type,
          proof_url, proof_public_id, notes, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
          proof_url, proof_public_id, notes, registered_by)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [recordId, ownerId, sourceAliquotPaymentId, remaining, paymentDate, paymentType,
       proofUrl, proofPublicId, [notes, 'Abono a mora sin período asociado'].filter(Boolean).join(' — '), registeredBy]
    );
    recordIds.push(recordId);
  }

  await client.query(
    'UPDATE condo_owners SET mora_amount = GREATEST(0, mora_amount - $1) WHERE id = $2',
    [amount, ownerId]
  );
  return recordIds;
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
       (id, name, description, category, expense_type, amount, is_active, is_recurring, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, name, description, category, expense_type AS "expenseType",
               amount::float, is_active AS "isActive", is_recurring AS "isRecurring",
               display_order AS "displayOrder", created_at AS "createdAt"`,
    [newId(), data.name, data.description || null, data.category, data.expenseType,
     data.amount, data.isActive, data.isRecurring, data.displayOrder]
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
       display_order = COALESCE($8, display_order)
     WHERE id = $9
     RETURNING id, name, description, category, expense_type AS "expenseType",
               amount::float, is_active AS "isActive", is_recurring AS "isRecurring",
               display_order AS "displayOrder", created_at AS "createdAt"`,
    [data.name || null, data.description ?? null, data.category || null, data.expenseType || null,
     data.amount ?? null, data.isActive ?? null, data.isRecurring ?? null, data.displayOrder ?? null,
     req.params.id]
  );
  if (!rows[0]) throw new AppError('Ítem de gasto no encontrado', 404);
  success(res, rows[0]);
});

// PATCH /condominium/expense-items/:id/toggle
router.patch('/expense-items/:id/toggle', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    `UPDATE condo_expense_items SET is_active = NOT is_active WHERE id = $1
     RETURNING id, name, is_active AS "isActive"`,
    [req.params.id]
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
    `INSERT INTO provision_catalog (id, name, description, calc_type, value, is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [newId(), data.name, data.description, data.calcType, data.value, data.isActive, data.sortOrder]
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
       updated_at  = NOW()
     WHERE id = $7 RETURNING *`,
    [data.name ?? null, data.description ?? null, data.calcType ?? null,
     data.value ?? null, data.isActive ?? null, data.sortOrder ?? null,
     req.params.id]
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
          capital_reserve_pct, capital_reserve_type, bad_debt_pct, bad_debt_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
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
       bad_debt_type        = COALESCE($13, bad_debt_type)
     WHERE id = $14 RETURNING *`,
    [
      data.name || null, data.adminEmail || null,
      data.fixedMaintenance  ?? null, data.fixedSecurity    ?? null,
      data.fixedCleaning     ?? null, data.fixedOther       ?? null,
      data.moraEnabled       ?? null, data.moraRate         ?? null,
      data.moraGraceDays     ?? null,
      data.capitalReservePct  ?? null, data.capitalReserveType || null,
      data.badDebtPct         ?? null, data.badDebtType        || null,
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

  success(res, { ...periodRes.rows[0], payments: paymentsRes.rows });
});

// POST /condominium/periods
router.post('/periods', authorize('ADMIN'), async (req, res) => {
  const data = z.object({
    month:            z.number().int().min(1).max(12),
    year:             z.number().int().min(2000),
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
    const provFilter = data.provisionIds && data.provisionIds.length > 0
      ? `AND id = ANY($1)`
      : '';
    const provParams = data.provisionIds && data.provisionIds.length > 0
      ? [data.provisionIds]
      : [];
    const provCatalog = await query(
      `SELECT * FROM provision_catalog WHERE is_active = TRUE ${provFilter} ORDER BY sort_order, created_at`,
      provParams
    );
    const provisionResults = provCatalog.rows.map(p => {
      const pVal = parseFloat(p.value) || 0;
      let amount;
      if (p.calc_type === 'FIXED') {
        amount = Math.round(pVal * 100) / 100;
      } else if (p.calc_type === 'VARIABLE') {
        const overrideAmt = data.provisionAmounts?.[p.id];
        amount = overrideAmt != null ? Math.round(overrideAmt * 100) / 100 : 0;
      } else {
        amount = Math.round(totalExpenses * pVal / 100 * 100) / 100;
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
          notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
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
           (id, period_id, expense_item_id, name, category, expense_type, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newId(), periodId, item.expenseItemId, item.name, item.category, item.expenseType, item.amount]
      );
    }

    // Crear entradas del libro auxiliar de fondos (misma transacción)
    for (const p of provisionResults) {
      if (p.calculatedAmount <= 0) continue;
      await client.query(
        `INSERT INTO condo_fund_entries
           (id, fund_type, provision_id, amount, entry_type, period_id, description, registered_by)
         VALUES ($1,'PROVISION',$2,$3,'PROVISION',$4,$5,$6)`,
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
      // Usar grand_total si existe (períodos con provisiones), si no total_expenses (retrocompat)
      const base = parseFloat(period.grand_total) > 0
        ? parseFloat(period.grand_total)
        : parseFloat(period.total_expenses);
      const aliquotAmount = Math.round(
        base * parseFloat(owner.participation_pct) / 100 * 100
      ) / 100;

      await client.query(
        `INSERT INTO aliquot_payments
           (id, period_id, owner_id, aliquot_amount, mora_at_billing)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (period_id, owner_id) DO UPDATE SET
           aliquot_amount = EXCLUDED.aliquot_amount,
           mora_at_billing = EXCLUDED.mora_at_billing`,
        // La mora pertenece al saldo del propietario; no se factura de nuevo
        // dentro de la alícuota mensual.
        [newId(), period.id, owner.id, aliquotAmount, 0]
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
        `UPDATE aliquot_payments SET status = $1 WHERE id = $2`,
        [pending > 0.01 ? 'OVERDUE' : 'PAID', ap.id]
      );
      if (pending > 0.01) {
        await client.query(
          `UPDATE condo_owners SET mora_amount = mora_amount + $1 WHERE id = $2`,
          [pending, ap.owner_id]
        );
      }
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
      `SELECT proof_public_id FROM aliquot_payments WHERE period_id = $1 AND proof_public_id IS NOT NULL`,
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
        `UPDATE condo_owners SET mora_amount = GREATEST(0, mora_amount - $1) WHERE id = $2`,
        [row.pending, row.owner_id]
      );
    }

    // 3. Eliminar registros relacionados en orden de dependencia
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
    `SELECT ap.*, o.mora_amount::float AS owner_mora_amount
     FROM aliquot_payments ap
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
  if (paidAmount > periodPending + moraAvailable + 0.01) {
    throw new AppError(`El valor excede el saldo del período y la mora disponible ($${(periodPending + moraAvailable).toFixed(2)})`, 400);
  }
  // La mora tiene prioridad: se cubre primero en FIFO (la más antigua a la
  // más reciente) y únicamente el remanente se aplica al período actual.
  const amountForMora = Math.min(paidAmount, moraAvailable);
  const amountForPeriod = Math.min(Math.max(0, paidAmount - amountForMora), periodPending);
  const newPaid = parseFloat(ap.paid_amount) + amountForPeriod;
  const status  = newPaid >= total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : ap.status;
  const paymentNotes = [
    notes || null,
    amountForMora > 0 ? `Pago aplicado prioritariamente a mora: $${amountForMora.toFixed(2)}` : null,
  ].filter(Boolean).join('\n') || null;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE aliquot_payments SET
         paid_amount = $1,
         payment_date = CASE WHEN $2::numeric > 0 THEN $3 ELSE payment_date END,
         status = $4, notes = $5, registered_by = $6
       WHERE id = $7 RETURNING *`,
      [newPaid, amountForPeriod, paymentDate, status, paymentNotes, req.user.id, ap.id]
    );
    let moraPaymentRecordIds = [];
    if (amountForMora > 0) {
      moraPaymentRecordIds = await applyMoraPayment(client, {
        ownerId: ap.owner_id, amount: amountForMora, paymentDate,
        paymentType: 'ALIQUOT_EXCESS', sourceAliquotPaymentId: ap.id,
        notes: 'Pago de alícuota aplicado prioritariamente a mora.', registeredBy: req.user.id,
      });
    }
    await client.query('COMMIT');
    success(res, { ...rows[0], moraPaymentRecordIds }, 200, `Pago registrado (${status})`);
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
         notes = $7, registered_by = $8
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

  const apRes = await query('SELECT id, status FROM aliquot_payments WHERE id = $1', [req.params.paymentId]);
  if (!apRes.rows[0]) throw new AppError('Pago no encontrado', 404);
  if (apRes.rows[0].status === 'PAID') throw new AppError('No se puede modificar un pago ya completado', 400);

  const { rows } = await query(
    `INSERT INTO aliquot_payment_extras (id, payment_id, amount, notes, created_by)
     VALUES ($1, $2, $3, $4, $5)
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
    `SELECT e.id, ap.status FROM aliquot_payment_extras e
     JOIN aliquot_payments ap ON ap.id = e.payment_id
     WHERE e.id = $1`,
    [req.params.extraId]
  );
  if (!exRes.rows[0]) throw new AppError('Cargo extra no encontrado', 404);
  if (exRes.rows[0].status === 'PAID') throw new AppError('No se puede modificar un pago ya completado', 400);

  const { rows } = await query(
    `UPDATE aliquot_payment_extras SET amount = $1, notes = $2
     WHERE id = $3
     RETURNING id, payment_id AS "paymentId", amount::float, notes, created_at AS "createdAt"`,
    [amount, notes, req.params.extraId]
  );
  success(res, rows[0], 200, 'Cargo extra actualizado');
});

// DELETE /condominium/extras/:extraId — eliminar cargo extra
router.delete('/extras/:extraId', authorize('ADMIN'), async (req, res) => {
  const exRes = await query(
    `SELECT e.id, ap.status FROM aliquot_payment_extras e
     JOIN aliquot_payments ap ON ap.id = e.payment_id
     WHERE e.id = $1`,
    [req.params.extraId]
  );
  if (!exRes.rows[0]) throw new AppError('Cargo extra no encontrado', 404);
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
  try {
    moraPaymentRecordIds = req.body.moraPaymentRecordIds ? JSON.parse(req.body.moraPaymentRecordIds) :
      (req.body.moraPaymentRecordId ? [req.body.moraPaymentRecordId] : []);
  } catch (_) {
    throw new AppError('Registros de abono a mora inválidos', 400);
  }
  if (!Array.isArray(moraPaymentRecordIds) || !moraPaymentRecordIds.every(id => typeof id === 'string')) {
    throw new AppError('Registros de abono a mora inválidos', 400);
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
       proof_url = $1, proof_public_id = $2, proof_uploaded_at = NOW(), status = $3
     WHERE id = $4 RETURNING *`,
    [url, publicId, newStatus, ap.id]
  );

  if (moraPaymentRecordIds.length) {
    await query(
      `UPDATE mora_payment_records SET proof_url = $1, proof_public_id = $2
       WHERE id = ANY($3)`,
      [url, publicId, moraPaymentRecordIds]
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
    `UPDATE aliquot_payments SET proof_url = NULL, proof_public_id = NULL, proof_uploaded_at = NULL
     WHERE id = $1`,
    [req.params.paymentId]
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
       (id, fund_type, provision_id, amount, entry_type, description, entry_date, registered_by)
     VALUES ($1,'PROVISION',$2,$3,$4,$5,$6,$7) RETURNING *`,
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

    const total_billed       = parseFloat(period.total_billed) || 0;
    const total_collected    = parseFloat(period.total_collected) || 0;
    const total_expenses     = parseFloat(period.total_expenses) || 0;
    const total_provisions   = parseFloat(period.total_provisions) || 0;
    const grand_total        = parseFloat(period.grand_total) > 0 ? parseFloat(period.grand_total) : total_expenses;
    const balance = Math.round((total_collected - grand_total) * 100) / 100;
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
    total_provisions: acc.total_provisions + r.egresos.total_provisions,
    grand_total:      acc.grand_total      + r.egresos.grand_total,
    net_result:       acc.net_result       + r.balance,
  }), { total_billed: 0, total_collected: 0, total_expenses: 0, total_provisions: 0, grand_total: 0, net_result: 0 });

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

  const periods = periodsRes.rows.map(period => ({
    ...period,
    expense_items: expenseItems.filter(item => item.period_id === period.id),
    provisions: periodProvisions.filter(provision => provision.period_id === period.id),
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
