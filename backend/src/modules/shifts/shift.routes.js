const { Router } = require('express');
const { z }      = require('zod');
const { query }  = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { newId }  = require('../../utils/id');

const router = Router();
router.use(authenticate);

// ── Plantillas ────────────────────────────────────────────────

// GET /shifts/templates
router.get('/templates', async (_req, res) => {
  const { rows } = await query(
    `SELECT * FROM shift_templates WHERE is_active = TRUE ORDER BY name`
  );
  success(res, rows);
});

// POST /shifts/templates
router.post('/templates', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const { name, startTime, endTime, color } = z.object({
    name:      z.string().min(2),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime:   z.string().regex(/^\d{2}:\d{2}$/),
    color:     z.string().default('#3B82F6'),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO shift_templates (id, name, start_time, end_time, color)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [newId(), name, startTime, endTime, color]
  );
  success(res, rows[0], 201);
});

// PUT /shifts/templates/:id
router.put('/templates/:id', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const data = z.object({
    name:      z.string().min(2).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    endTime:   z.string().regex(/^\d{2}:\d{2}$/).optional(),
    color:     z.string().optional(),
    isActive:  z.boolean().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE shift_templates SET
       name       = COALESCE($1, name),
       start_time = COALESCE($2, start_time),
       end_time   = COALESCE($3, end_time),
       color      = COALESCE($4, color),
       is_active  = COALESCE($5, is_active)
     WHERE id = $6 RETURNING *`,
    [data.name || null, data.startTime || null, data.endTime || null,
     data.color || null, data.isActive ?? null, req.params.id]
  );
  if (!rows[0]) throw new AppError('Plantilla no encontrada', 404);
  success(res, rows[0]);
});

// ── Asignaciones ──────────────────────────────────────────────

// GET /shifts/assignments?start=YYYY-MM-DD&end=YYYY-MM-DD&employeeId=...
router.get('/assignments', async (req, res) => {
  const { start, end, employeeId } = req.query;

  const conditions = ['1=1'];
  const params     = [];
  let idx = 1;

  if (start)      { conditions.push(`sa.date >= $${idx}`); params.push(start); idx++; }
  if (end)        { conditions.push(`sa.date <= $${idx}`); params.push(end); idx++; }
  if (employeeId) { conditions.push(`sa.employee_id = $${idx}`); params.push(employeeId); idx++; }

  const { rows } = await query(
    `SELECT sa.*,
            e.first_name, e.last_name,
            st.name AS shift_name, st.start_time, st.end_time, st.color
     FROM shift_assignments sa
     JOIN employees e ON e.id = sa.employee_id
     JOIN shift_templates st ON st.id = sa.shift_template_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sa.date, e.last_name`,
    params
  );
  success(res, rows);
});

// POST /shifts/assignments
router.post('/assignments', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const { employeeId, shiftTemplateId, date, notes } = z.object({
    employeeId:      z.string(),
    shiftTemplateId: z.string(),
    date:            z.string(),
    notes:           z.string().optional(),
  }).parse(req.body);

  const { rows } = await query(
    `INSERT INTO shift_assignments (id, employee_id, shift_template_id, date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (employee_id, date) DO UPDATE SET
       shift_template_id = EXCLUDED.shift_template_id,
       notes = EXCLUDED.notes
     RETURNING *`,
    [newId(), employeeId, shiftTemplateId, date, notes || null, req.user.id]
  );
  success(res, rows[0], 201);
});

// DELETE /shifts/assignments/:id
router.delete('/assignments/:id', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const { rows } = await query(
    'DELETE FROM shift_assignments WHERE id = $1 RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Asignación no encontrada', 404);
  success(res, null, 200, 'Turno eliminado');
});

// POST /shifts/assignments/bulk — asignación masiva
router.post('/assignments/bulk', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const { employeeIds, shiftTemplateId, dates } = z.object({
    employeeIds:     z.array(z.string()).min(1),
    shiftTemplateId: z.string(),
    dates:           z.array(z.string()).min(1),
  }).parse(req.body);

  let count = 0;
  for (const empId of employeeIds) {
    for (const date of dates) {
      await query(
        `INSERT INTO shift_assignments (id, employee_id, shift_template_id, date, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (employee_id, date) DO UPDATE SET shift_template_id = EXCLUDED.shift_template_id`,
        [newId(), empId, shiftTemplateId, date, req.user.id]
      );
      count++;
    }
  }
  success(res, null, 200, `${count} turnos asignados`);
});

module.exports = router;
