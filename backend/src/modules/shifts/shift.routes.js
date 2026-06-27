const { Router } = require('express');
const { z }      = require('zod');
const { query, getClient }  = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success } = require('../../utils/response');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { newId }  = require('../../utils/id');
const { generateShiftSchedulePdf } = require('../../services/pdf.service');

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

// PUT /shifts/assignments/:id
// Si el guardia elegido ya tiene un turno en la misma fecha, se intercambian
// las plantillas de ambos registros. Así la edición de un horario completo
// conserva sus 4 turnos y un solo turno por guardia y día.
router.put('/assignments/:id', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const data = z.object({
    employeeId: z.string(),
    shiftTemplateId: z.string(),
    date: z.string().regex(DATE_RE),
  }).parse(req.body);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT * FROM shift_assignments WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    const current = currentResult.rows[0];
    if (!current) throw new AppError('Asignación no encontrada', 404);

    const targetResult = await client.query(
      `SELECT * FROM shift_assignments
       WHERE employee_id = $1 AND date = $2 AND id <> $3
       FOR UPDATE`,
      [data.employeeId, data.date, current.id]
    );
    const target = targetResult.rows[0];

    let updated;
    if (target) {
      // Se intercambian los turnos, no los empleados. Esto es atómico y no
      // afecta UNIQUE(employee_id, date).
      await client.query(
        `UPDATE shift_assignments
         SET shift_template_id = CASE WHEN id = $1 THEN $2 ELSE $3 END,
             date = CASE WHEN id = $1 THEN $4 ELSE date END,
             notes = NULL,
             created_by = $5
         WHERE id IN ($1, $6)`,
        [current.id, target.shift_template_id, data.shiftTemplateId, data.date, req.user.id, target.id]
      );
      const currentAfter = await client.query(
        `SELECT * FROM shift_assignments WHERE id = $1`, [current.id]
      );
      updated = currentAfter.rows[0];
    } else {
      const result = await client.query(
        `UPDATE shift_assignments
         SET employee_id = $1, shift_template_id = $2, date = $3, notes = NULL, created_by = $4
         WHERE id = $5
         RETURNING *`,
        [data.employeeId, data.shiftTemplateId, data.date, req.user.id, current.id]
      );
      updated = result.rows[0];
    }

    await client.query('COMMIT');
    success(res, updated, 200, target ? 'Turnos intercambiados' : 'Turno actualizado');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

// ── Rotación de guardias ─────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROTATION_ROLES = [
  { key: 'morning',   labels: ['mañana', 'manana', 'diurno'],     defaults: ['Diurno', '06:00', '14:00', '#22C55E'] },
  { key: 'afternoon', labels: ['tarde', 'vespertino'],            defaults: ['Vespertino', '14:00', '22:00', '#F59E0B'] },
  { key: 'night',     labels: ['noche', 'nocturno'],              defaults: ['Nocturno', '22:00', '06:00', '#6366F1'] },
  { key: 'rest',      labels: ['descanso'],                        defaults: ['Descanso', '00:00', '00:00', '#64748B'] },
];

const eachDate = (startDate, endDate) => {
  const dates = [];
  const current = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
};

const findTemplateForRole = (templates, role) => templates.find((template) => {
  const name = String(template.name || '').toLocaleLowerCase('es');
  return role.labels.some((label) => name.includes(label));
});

// POST /shifts/rotation/generate
// Cada día cada guardia avanza: Mañana → Tarde → Noche → Descanso.
// Este orden conserva cobertura continua y prioriza el mayor descanso entre turnos.
router.post('/rotation/generate', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const data = z.object({
    startDate: z.string().regex(DATE_RE),
    endDate: z.string().regex(DATE_RE),
    employeeIds: z.array(z.string()).length(4),
    morningShiftTemplateId: z.string().optional(),
    afternoonShiftTemplateId: z.string().optional(),
    nightShiftTemplateId: z.string().optional(),
    restShiftTemplateId: z.string().optional(),
    overwrite: z.boolean().default(false),
  }).parse(req.body);

  if (data.startDate > data.endDate) {
    throw new AppError('La fecha inicial no puede ser posterior a la fecha final', 400);
  }
  if (new Set(data.employeeIds).size !== 4) {
    throw new AppError('Selecciona cuatro guardias distintos para la rotación', 400);
  }

  const dates = eachDate(data.startDate, data.endDate);
  if (dates.length > 62) {
    throw new AppError('La generación está limitada a un máximo de 62 días', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const employees = await client.query(
      `SELECT id FROM employees WHERE id = ANY($1::varchar[]) AND status = 'ACTIVE'`,
      [data.employeeIds]
    );
    if (employees.rows.length !== 4) {
      throw new AppError('Los cuatro guardias seleccionados deben estar activos', 400);
    }

    const existing = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM shift_assignments
       WHERE date BETWEEN $1 AND $2 AND employee_id = ANY($3::varchar[])`,
      [data.startDate, data.endDate, data.employeeIds]
    );
    if (existing.rows[0].total > 0 && !data.overwrite) {
      throw new AppError(
        'Ya existen turnos para este período. Activa la opción para reemplazarlos si deseas regenerar el horario.',
        409
      );
    }

    let templates = (await client.query(
      `SELECT id, name, start_time, end_time, color FROM shift_templates WHERE is_active = TRUE`
    )).rows;

    const requestedTemplateIds = {
      morning: data.morningShiftTemplateId,
      afternoon: data.afternoonShiftTemplateId,
      night: data.nightShiftTemplateId,
      rest: data.restShiftTemplateId,
    };
    const templateById = new Map(templates.map((template) => [template.id, template]));
    const roleTemplates = {};

    for (const role of ROTATION_ROLES) {
      const requested = requestedTemplateIds[role.key];
      const template = requested ? templateById.get(requested) : findTemplateForRole(templates, role);
      if (template) roleTemplates[role.key] = template;
    }

    // Las instalaciones antiguas podían no tener las cuatro plantillas base.
    // Solo se agregan las que falten; las plantillas elegidas por el usuario
    // siempre tienen prioridad.
    for (const role of ROTATION_ROLES) {
      if (roleTemplates[role.key]) continue;
      if (requestedTemplateIds[role.key]) {
        throw new AppError(`La plantilla seleccionada para ${role.key} no está activa o no existe`, 400);
      }
      const [name, startTime, endTime, color] = role.defaults;
      const { rows } = await client.query(
        `INSERT INTO shift_templates (id, name, start_time, end_time, color)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO UPDATE SET is_active = TRUE
         RETURNING id, name, start_time, end_time, color`,
        [newId(), name, startTime, endTime, color]
      );
      roleTemplates[role.key] = rows[0];
      templates = [...templates, rows[0]];
    }

    const missingRoles = ROTATION_ROLES
      .filter((role) => !roleTemplates[role.key])
      .map((role) => role.key);
    if (missingRoles.length) {
      throw new AppError(
        `Faltan plantillas para: ${missingRoles.join(', ')}. Configúralas antes de generar la rotación.`,
        400
      );
    }

    let count = 0;
    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      for (let roleIndex = 0; roleIndex < ROTATION_ROLES.length; roleIndex++) {
        const role = ROTATION_ROLES[roleIndex];
        const employeeIndex = ((roleIndex - dayIndex) % data.employeeIds.length + data.employeeIds.length)
          % data.employeeIds.length;
        const employeeId = data.employeeIds[
          employeeIndex
        ];
        await client.query(
          `INSERT INTO shift_assignments (id, employee_id, shift_template_id, date, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (employee_id, date) DO UPDATE SET
             shift_template_id = EXCLUDED.shift_template_id,
             notes = NULL,
             created_by = EXCLUDED.created_by`,
          [newId(), employeeId, roleTemplates[role.key].id, dates[dayIndex], req.user.id]
        );
        count++;
      }
    }

    await client.query('COMMIT');
    success(res, {
      count,
      roleTemplateIds: Object.fromEntries(
        Object.entries(roleTemplates).map(([key, template]) => [key, template.id])
      ),
    }, 200, `Horario generado: ${count} asignaciones`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// GET /shifts/schedule/pdf?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/schedule/pdf', async (req, res) => {
  const data = z.object({
    start: z.string().regex(DATE_RE),
    end: z.string().regex(DATE_RE),
  }).parse(req.query);
  if (data.start > data.end) throw new AppError('Rango de fechas inválido', 400);

  const expectedDates = eachDate(data.start, data.end);
  if (expectedDates.length > 62) throw new AppError('El reporte admite un máximo de 62 días', 400);

  const { rows } = await query(
    `SELECT sa.date, sa.shift_template_id, e.first_name, e.last_name,
            st.name AS shift_name, st.start_time, st.end_time, st.color
     FROM shift_assignments sa
     JOIN employees e ON e.id = sa.employee_id
     JOIN shift_templates st ON st.id = sa.shift_template_id
     WHERE sa.date BETWEEN $1 AND $2
     ORDER BY sa.date, st.name, e.last_name, e.first_name`,
    [data.start, data.end]
  );

  const incompleteDates = expectedDates.filter((date) =>
    rows.filter((assignment) => String(assignment.date).slice(0, 10) === date).length < 4
  );
  if (incompleteDates.length) {
    throw new AppError(
      `El horario aún está incompleto (${incompleteDates.length} día(s) sin los cuatro turnos).`,
      400
    );
  }

  const pdfBuffer = await generateShiftSchedulePdf({
    startDate: data.start,
    endDate: data.end,
    assignments: rows,
  });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="horario-guardias-${data.start}-${data.end}.pdf"`,
  });
  res.send(pdfBuffer);
});

module.exports = router;
