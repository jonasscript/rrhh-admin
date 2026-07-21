const { Router } = require('express');
const { z }       = require('zod');
const bcrypt      = require('bcryptjs');
const { query }   = require('../../config/db');
const AppError    = require('../../utils/AppError');
const { success, paginated } = require('../../utils/response');
const { newId }   = require('../../utils/id');
const { authenticate, authorize } = require('../../middleware/auth.middleware');

const router = Router();

// ── Schemas ───────────────────────────────────────────────────
const createSchema = z.object({
  email:    z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  role:     z.enum(['ADMIN', 'HR', 'SUPERVISOR', 'EMPLEADO']),
});

const updateSchema = z.object({
  role:      z.enum(['ADMIN', 'HR', 'SUPERVISOR', 'EMPLEADO']).optional(),
  isActive:  z.boolean().optional(),
}).refine(d => d.role !== undefined || d.isActive !== undefined, {
  message: 'Debe enviar al menos role o isActive',
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

// ── POST /users ───────────────────────────────────────────────
// Registro público de un nuevo usuario del sistema
router.post('/', async (req, res) => {
  const { email, password, role } = createSchema.parse(req.body);

  // Verificar duplicado
  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) throw new AppError('Ya existe un usuario con ese correo', 409);

  const hashed = await bcrypt.hash(password, 12);
  const id     = newId();

  const { rows } = await query(
    `INSERT INTO users (id, email, password, role, created_by, updated_by)
     VALUES ($1, $2, $3, $4, NULL, NULL)
     RETURNING id, email, role, is_active, created_at`,
    [id, email, hashed, role]
  );

  success(res, rows[0], 201, 'Usuario registrado exitosamente');
});

// Las demás rutas de usuarios requieren autenticación.
router.use(authenticate);

// ── GET /users ─────────────────────────────────────────────────
// Lista paginada; filtros: search (email), role, isActive
router.get('/', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const offset = (page - 1) * limit;

  const conditions = ['1=1'];
  const params     = [];
  let   idx        = 1;

  if (req.query.search) {
    conditions.push(`u.email ILIKE $${idx}`);
    params.push(`%${req.query.search}%`);
    idx++;
  }
  if (req.query.role) {
    conditions.push(`u.role = $${idx}`);
    params.push(req.query.role);
    idx++;
  }
  if (req.query.isActive !== undefined) {
    conditions.push(`u.is_active = $${idx}`);
    params.push(req.query.isActive === 'true');
    idx++;
  }

  const where = conditions.join(' AND ');

  const countRes = await query(
    `SELECT COUNT(*) FROM users u WHERE ${where}`,
    params
  );
  const dataRes = await query(
    `SELECT u.id, u.email, u.role, u.is_active, u.created_at, u.updated_at,
            e.first_name, e.last_name, e.photo_url
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE ${where}
     ORDER BY u.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  paginated(res, dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit);
});

// ── GET /users/:id ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.role, u.is_active, u.created_at, u.updated_at,
            e.first_name, e.last_name, e.cedula, e.position, e.photo_url
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE u.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Usuario no encontrado', 404);
  success(res, rows[0]);
});

// ── PUT /users/:id ────────────────────────────────────────────
// Actualizar rol y/o estado activo de un usuario
router.put('/:id', authorize('ADMIN', 'HR'), async (req, res) => {
  const data = updateSchema.parse(req.body);

  const existing = await query('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) throw new AppError('Usuario no encontrado', 404);

  const fields = [];
  const params = [];
  let   idx    = 1;

  if (data.role !== undefined)     { fields.push(`role = $${idx}`);      params.push(data.role);     idx++; }
  if (data.isActive !== undefined) { fields.push(`is_active = $${idx}`); params.push(data.isActive); idx++; }
  fields.push(`updated_by = $${idx}`);
  params.push(req.user.id);
  idx++;

  params.push(req.params.id);

  const { rows } = await query(
    `UPDATE users SET ${fields.join(', ')}
     WHERE id = $${idx}
     RETURNING id, email, role, is_active, updated_at`,
    params
  );
  success(res, rows[0], 200, 'Usuario actualizado');
});

// ── DELETE /users/:id ─────────────────────────────────────────
// Desactivar usuario (soft delete — no borra el registro)
router.delete('/:id', authorize('ADMIN'), async (req, res) => {  const { rows } = await query(
    `UPDATE users SET is_active = false, updated_by = $1
     WHERE id = $2
     RETURNING id, email, is_active`,
    [req.user.id, req.params.id]
  );
  if (!rows[0]) throw new AppError('Usuario no encontrado', 404);
  success(res, rows[0], 200, 'Usuario desactivado');
});

// ── POST /users/:id/reset-password ────────────────────────────
// El admin restablece la contraseña de otro usuario
router.post('/:id/reset-password', authorize('ADMIN', 'HR'), async (req, res) => {
  const { newPassword } = resetPasswordSchema.parse(req.body);

  const existing = await query('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) throw new AppError('Usuario no encontrado', 404);

  const hashed = await bcrypt.hash(newPassword, 12);
  await query(
    'UPDATE users SET password = $1, updated_by = $2 WHERE id = $3',
    [hashed, req.user.id, req.params.id]
  );

  success(res, null, 200, 'Contraseña restablecida exitosamente');
});

module.exports = router;
