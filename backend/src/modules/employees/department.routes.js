const { Router } = require('express');
const { z }      = require('zod');
const { query }  = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { newId }  = require('../../utils/id');

const router = Router();
router.use(authenticate);

// GET /departments
router.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT d.*, COUNT(e.id)::int AS employee_count
     FROM departments d
     LEFT JOIN employees e ON e.department_id = d.id AND e.status != 'INACTIVE'
     GROUP BY d.id
     ORDER BY d.name`
  );
  success(res, rows);
});

// GET /departments/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM departments WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw new AppError('Departamento no encontrado', 404);
  success(res, rows[0]);
});

// POST /departments
router.post('/', authorize('ADMIN', 'HR'), async (req, res) => {
  const { name, description } = z.object({
    name:        z.string().min(2),
    description: z.string().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO departments (id, name, description, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4) RETURNING *`,
    [newId(), name, description || null, req.user.id]
  );
  success(res, rows[0], 201, 'Departamento creado');
});

// PUT /departments/:id
router.put('/:id', authorize('ADMIN', 'HR'), async (req, res) => {
  const { name, description } = z.object({
    name:        z.string().min(2).optional(),
    description: z.string().optional().nullable(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE departments SET
       name        = COALESCE($1, name),
       description = COALESCE($2, description),
       updated_by  = $3
     WHERE id = $4 RETURNING *`,
    [name || null, description ?? null, req.user.id, req.params.id]
  );
  if (!rows[0]) throw new AppError('Departamento no encontrado', 404);
  success(res, rows[0]);
});

// DELETE /departments/:id
router.delete('/:id', authorize('ADMIN'), async (req, res) => {
  // Desasociar empleados antes de eliminar
  await query(
    `UPDATE employees SET department_id = NULL, updated_by = $1 WHERE department_id = $2`,
    [req.user.id, req.params.id]
  );
  const { rows } = await query('DELETE FROM departments WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) throw new AppError('Departamento no encontrado', 404);
  success(res, null, 200, 'Departamento eliminado');
});

module.exports = router;
