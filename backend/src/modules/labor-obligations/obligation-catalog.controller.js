const { z }     = require('zod');
const { query } = require('../../config/db');
const AppError  = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { newId }   = require('../../utils/id');

const catalogSchema = z.object({
  name:          z.string().min(1).max(100),
  description:   z.string().optional().nullable(),
  calc_type:     z.enum(['PERCENTAGE', 'FIXED']),
  default_value: z.number().min(0).optional().nullable(),
  payer:         z.enum(['EMPLOYER', 'EMPLOYEE']),
  recipient:     z.enum(['IESS', 'EMPLOYEE', 'OTHER']),
  is_active:     z.boolean().optional(),
  display_order: z.number().int().optional(),
  payment_mode:  z.enum(['MONTHLY', 'LUMP_SUM']).optional(),
  payment_month: z.number().int().min(1).max(12).optional().nullable(),
  payment_day:   z.number().int().min(1).max(31).optional().nullable(),
});

// GET /obligation-catalog
const listCatalog = async (_req, res) => {
  const { rows } = await query(
    `SELECT * FROM obligation_catalog ORDER BY display_order, name`,
    []
  );
  success(res, rows);
};

// POST /obligation-catalog
const createObligation = async (req, res) => {
  const data = catalogSchema.parse(req.body);

  const { rows } = await query(
    `INSERT INTO obligation_catalog
       (id, code, name, description, calc_type, default_value, payer, recipient,
        is_system, is_active, display_order, payment_mode, payment_month, payment_day,
        created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9, $10, $11, $12, $13, $14, $14)
     RETURNING *`,
    [
      newId(),
      (req.body.code || data.name.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '')).substring(0, 50),
      data.name,
      data.description ?? null,
      data.calc_type,
      data.default_value ?? null,
      data.payer,
      data.recipient,
      data.is_active ?? true,
      data.display_order ?? 99,
      data.payment_mode  ?? 'MONTHLY',
      data.payment_month ?? null,
      data.payment_day   ?? null,
      req.user.id,
    ]
  );
  success(res, rows[0], 201, 'Obligación creada');
};

// PUT /obligation-catalog/:id
const updateObligation = async (req, res) => {
  const { id } = req.params;

  const existing = await query('SELECT * FROM obligation_catalog WHERE id = $1', [id]);
  if (!existing.rows[0]) throw new AppError('Obligación no encontrada', 404);

  const cat = existing.rows[0];

  // Block changing default_value on system obligations
  if (cat.is_system && req.body.default_value !== undefined && req.body.default_value !== null) {
    const incoming = parseFloat(req.body.default_value);
    if (incoming !== parseFloat(cat.default_value)) {
      throw new AppError(
        'Las tasas de obligaciones del sistema (is_system) solo pueden modificarse mediante una migración de base de datos',
        403
      );
    }
  }

  const schema = z.object({
    name:          z.string().min(1).max(100).optional(),
    description:   z.string().optional().nullable(),
    calc_type:     z.enum(['PERCENTAGE', 'FIXED']).optional(),
    default_value: z.number().min(0).optional().nullable(),
    payer:         z.enum(['EMPLOYER', 'EMPLOYEE']).optional(),
    recipient:     z.enum(['IESS', 'EMPLOYEE', 'OTHER']).optional(),
    is_active:     z.boolean().optional(),
    display_order: z.number().int().optional(),
    payment_mode:  z.enum(['MONTHLY', 'LUMP_SUM']).optional(),
    payment_month: z.number().int().min(1).max(12).optional().nullable(),
    payment_day:   z.number().int().min(1).max(31).optional().nullable(),
  });
  const data = schema.parse(req.body);

  const fields = [];
  const vals   = [];
  let idx = 1;

  if (data.name          !== undefined) { fields.push(`name = $${idx++}`);          vals.push(data.name); }
  if (data.description   !== undefined) { fields.push(`description = $${idx++}`);   vals.push(data.description); }
  if (data.calc_type     !== undefined && !cat.is_system) { fields.push(`calc_type = $${idx++}`); vals.push(data.calc_type); }
  if (data.default_value !== undefined) { fields.push(`default_value = $${idx++}`); vals.push(data.default_value); }
  if (data.payer         !== undefined && !cat.is_system) { fields.push(`payer = $${idx++}`);     vals.push(data.payer); }
  if (data.recipient     !== undefined && !cat.is_system) { fields.push(`recipient = $${idx++}`); vals.push(data.recipient); }
  if (data.is_active     !== undefined) { fields.push(`is_active = $${idx++}`);     vals.push(data.is_active); }
  if (data.display_order !== undefined) { fields.push(`display_order = $${idx++}`); vals.push(data.display_order); }
  if (data.payment_mode  !== undefined && !cat.is_system) { fields.push(`payment_mode = $${idx++}`);  vals.push(data.payment_mode); }
  if (data.payment_month !== undefined) { fields.push(`payment_month = $${idx++}`); vals.push(data.payment_month); }
  if (data.payment_day   !== undefined) { fields.push(`payment_day = $${idx++}`);   vals.push(data.payment_day); }

  if (fields.length === 0) throw new AppError('Nada que actualizar', 400);

  fields.push(`updated_by = $${idx++}`);
  vals.push(req.user.id);

  vals.push(id);
  const { rows } = await query(
    `UPDATE obligation_catalog SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  success(res, rows[0], 200, 'Obligación actualizada');
};

// DELETE /obligation-catalog/:id  — soft delete
const deactivateObligation = async (req, res) => {
  const { id } = req.params;

  const existing = await query('SELECT * FROM obligation_catalog WHERE id = $1', [id]);
  if (!existing.rows[0]) throw new AppError('Obligación no encontrada', 404);
  if (existing.rows[0].is_system) throw new AppError('Las obligaciones del sistema no se pueden desactivar', 403);

  // Check if any employees are actively using it
  const usageRes = await query(
    `SELECT COUNT(*) FROM employee_obligations WHERE obligation_id = $1 AND is_active = TRUE`,
    [id]
  );
  if (parseInt(usageRes.rows[0].count, 10) > 0) {
    throw new AppError(
      `No se puede desactivar: ${usageRes.rows[0].count} empleado(s) tienen esta obligación activa`,
      409
    );
  }

  const { rows } = await query(
    `UPDATE obligation_catalog SET is_active = FALSE, updated_by = $1 WHERE id = $2 RETURNING *`,
    [req.user.id, id]
  );
  success(res, rows[0], 200, 'Obligación desactivada');
};

module.exports = { listCatalog, createObligation, updateObligation, deactivateObligation };
