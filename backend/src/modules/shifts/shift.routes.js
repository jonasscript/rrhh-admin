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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Plantillas ────────────────────────────────────────────────

// GET /shifts/templates
router.get('/templates', async (_req, res) => {
  const { rows } = await query(
    `SELECT * FROM shift_templates WHERE is_active = TRUE ORDER BY name`
  );
  success(res, rows.map(withOfficialShiftTimes));
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
    `INSERT INTO shift_templates (id, name, start_time, end_time, color, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [newId(), name, startTime, endTime, color, req.user.id]
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
       is_active  = COALESCE($5, is_active),
       updated_by = $6
     WHERE id = $7 RETURNING *`,
    [data.name || null, data.startTime || null, data.endTime || null,
     data.color || null, data.isActive ?? null, req.user.id, req.params.id]
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
            sa.date::text AS date,
            e.first_name, e.last_name,
            st.name AS shift_name, st.start_time, st.end_time, st.color
     FROM shift_assignments sa
     JOIN employees e ON e.id = sa.employee_id
     JOIN shift_templates st ON st.id = sa.shift_template_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sa.date, e.last_name`,
    params
  );
  success(res, rows.map(withOfficialShiftTimes));
});

// POST /shifts/assignments
router.post('/assignments', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const { employeeId, shiftTemplateId, date, notes } = z.object({
    employeeId:      z.string(),
    shiftTemplateId: z.string(),
    date:            z.string().regex(DATE_RE),
    notes:           z.string().optional(),
  }).parse(req.body);

  await assertEmployeeAvailable(employeeId, date);

  const { rows } = await query(
    `INSERT INTO shift_assignments (id, employee_id, shift_template_id, date, notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (employee_id, date) DO UPDATE SET
       shift_template_id = EXCLUDED.shift_template_id,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [newId(), employeeId, shiftTemplateId, date, notes || null, req.user.id]
  );
  success(res, rows[0], 201);
});

// PUT /shifts/assignments/:id
// Si el guardia elegido ya tiene un turno en la misma fecha, se intercambian
// las plantillas de ambos registros. Así la edición de un horario completo
// conserva sus turnos y un solo turno por guardia y día.
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

    const vacationResult = await client.query(
      `SELECT 1
       FROM vacation_requests
       WHERE employee_id = $1
         AND status = 'APPROVED'
         AND start_date <= $2::date
         AND end_date >= $2::date
       LIMIT 1`,
      [data.employeeId, data.date]
    );
    if (vacationResult.rows[0]) {
      throw new AppError('El guardia seleccionado está de vacaciones en esa fecha', 400);
    }

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
             updated_by = $5
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
         SET employee_id = $1, shift_template_id = $2, date = $3, notes = NULL, updated_by = $4
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
      await assertEmployeeAvailable(empId, date);
      await query(
        `INSERT INTO shift_assignments (id, employee_id, shift_template_id, date, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (employee_id, date) DO UPDATE SET
           shift_template_id = EXCLUDED.shift_template_id,
           updated_by = EXCLUDED.updated_by`,
        [newId(), empId, shiftTemplateId, date, req.user.id]
      );
      count++;
    }
  }
  success(res, null, 200, `${count} turnos asignados`);
});

// ── Vacaciones operativas para turnos ─────────────────────────

// GET /shifts/vacations?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/vacations', async (req, res) => {
  const data = z.object({
    start: z.string().regex(DATE_RE),
    end:   z.string().regex(DATE_RE),
  }).parse(req.query);
  if (data.start > data.end) throw new AppError('Rango de fechas inválido', 400);

  const { rows } = await query(
    `SELECT vr.id,
            vr.employee_id AS "employeeId",
            vr.start_date::text AS "startDate",
            vr.end_date::text AS "endDate",
            vr.days_requested::float AS "daysRequested",
            vr.reason,
            e.first_name AS "firstName",
            e.last_name AS "lastName"
     FROM vacation_requests vr
     JOIN employees e ON e.id = vr.employee_id
     WHERE vr.status = 'APPROVED'
       AND vr.start_date <= $2::date
       AND vr.end_date >= $1::date
     ORDER BY vr.start_date ASC, e.last_name ASC, e.first_name ASC`,
    [data.start, data.end]
  );
  success(res, rows);
});

// POST /shifts/vacations — registrar vacaciones desde calendario de turnos
router.post('/vacations', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const data = z.object({
    employeeId:  z.string(),
    replacementEmployeeId: z.string().optional(),
    startDate:   z.string().regex(DATE_RE),
    endDate:     z.string().regex(DATE_RE).optional(),
    daysRequested: z.coerce.number().int().positive().optional(),
    reason:      z.string().max(500).optional(),
    reorganize:  z.boolean().default(false),
  }).parse(req.body);
  if (!data.daysRequested && !data.endDate) throw new AppError('Indica los días de vacaciones o la fecha final', 400);

  const daysRequested = data.daysRequested || eachDate(data.startDate, data.endDate).length;
  const endDate = data.daysRequested ? addCalendarDays(data.startDate, data.daysRequested - 1) : data.endDate;
  const returnDate = addCalendarDays(endDate, 1);
  if (data.startDate > endDate) throw new AppError('La fecha inicial no puede ser posterior a la fecha final', 400);
  if (data.reorganize && !data.replacementEmployeeId) {
    throw new AppError('Selecciona el guardia que reemplazará los turnos durante las vacaciones', 400);
  }
  if (data.replacementEmployeeId && data.replacementEmployeeId === data.employeeId) {
    throw new AppError('El reemplazo debe ser distinto al guardia que sale de vacaciones', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const employee = await client.query(
      `SELECT id FROM employees WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [data.employeeId]
    );
    if (!employee.rows[0]) throw new AppError('Empleado activo no encontrado', 404);

    if (data.reorganize) {
      const replacement = await client.query(
        `SELECT id FROM employees WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
        [data.replacementEmployeeId]
      );
      if (!replacement.rows[0]) throw new AppError('Guardia reemplazo activo no encontrado', 404);
    }

    const balance = await client.query(
      `SELECT available_days
       FROM vacation_balances
       WHERE employee_id = $1
       FOR UPDATE`,
      [data.employeeId]
    );
    if (!balance.rows[0]) throw new AppError('Empleado sin saldo de vacaciones', 404);
    if (parseFloat(balance.rows[0].available_days) < daysRequested) {
      throw new AppError('Saldo insuficiente de vacaciones', 400);
    }

    const overlap = await client.query(
      `SELECT 1
       FROM vacation_requests
       WHERE employee_id = $1
         AND status IN ('PENDING','APPROVED')
         AND start_date <= $3::date
         AND end_date >= $2::date
       LIMIT 1`,
      [data.employeeId, data.startDate, endDate]
    );
    if (overlap.rows[0]) throw new AppError('El empleado ya tiene vacaciones registradas en ese rango', 400);

    const { rows } = await client.query(
      `INSERT INTO vacation_requests
       (id, employee_id, start_date, end_date, days_requested, status, reason, reviewed_by, reviewed_at, review_notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'APPROVED',$6,$7,NOW(),'Registrado desde calendario de turnos',$7,$7)
       RETURNING id`,
      [newId(), data.employeeId, data.startDate, endDate, daysRequested, data.reason || 'Vacaciones operativas', req.user.id]
    );

    await client.query(
      `UPDATE vacation_balances
       SET available_days = available_days - $1,
           used_days = used_days + $1,
           updated_at = NOW(),
           updated_by = $2
       WHERE employee_id = $3`,
      [daysRequested, req.user.id, data.employeeId]
    );

    const reorganization = data.reorganize
      ? await reorganizeVacationAssignments(client, {
        employeeId: data.employeeId,
        replacementEmployeeId: data.replacementEmployeeId,
        startDate: data.startDate,
        endDate,
        userId: req.user.id,
      })
      : { affected: 0, reassigned: 0, removedRest: 0, unresolved: 0 };

    await client.query('COMMIT');
    success(res, { id: rows[0].id, startDate: data.startDate, endDate, returnDate, daysRequested, reorganization }, 201, 'Vacaciones registradas');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// ── Rotación de guardias ─────────────────────────────────────

const ROTATION_ROLES = [
  { key: 'morning',   labels: ['mañana', 'manana', 'diurno'],     defaults: ['Mañana', '07:00', '15:00', '#22C55E'] },
  { key: 'afternoon', labels: ['tarde', 'vespertino'],            defaults: ['Tarde', '15:00', '21:00', '#F59E0B'] },
  { key: 'night',     labels: ['noche', 'nocturno'],              defaults: ['Noche', '21:00', '07:00', '#6366F1'] },
  { key: 'rest',      labels: ['descanso'],                       defaults: ['Descanso', '00:00', '00:00', '#64748B'] },
];
const GUARDS_PER_ROTATION = 4;

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

const addCalendarDays = (date, days) => {
  const value = new Date(`${date}T12:00:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const toDateKey = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
};

const assertEmployeeAvailable = async (employeeId, date) => {
  const { rows } = await query(
    `SELECT 1
     FROM vacation_requests
     WHERE employee_id = $1
       AND status = 'APPROVED'
       AND start_date <= $2::date
       AND end_date >= $2::date
     LIMIT 1`,
    [employeeId, date]
  );
  if (rows[0]) throw new AppError('El guardia seleccionado está de vacaciones en esa fecha', 400);
};

const findTemplateForRole = (templates, role) => templates.find((template) => {
  const name = String(template.name || '').toLocaleLowerCase('es');
  return role.labels.some((label) => name.includes(label));
});

const normalizeShiftText = (value) => String(value || '')
  .toLocaleLowerCase('es')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const roleKeyForShift = (shift) => {
  const name = normalizeShiftText(shift.shift_name || shift.name);
  const start = String(shift.start_time || '').slice(0, 5);
  const end = String(shift.end_time || '').slice(0, 5);
  if (name.includes('descanso')) return 'rest';
  if (
    name.includes('nocturno') || name.includes('noche') ||
    (start === '21:00' && ['07:00', '06:00'].includes(end)) ||
    (start === '22:00' && end === '06:00')
  ) return 'night';
  if (
    name.includes('vespertino') || name.includes('tarde') ||
    (['14:00', '15:00'].includes(start) && ['21:00', '22:00'].includes(end))
  ) return 'afternoon';
  if (
    name.includes('diurno') || name.includes('manana') ||
    (['06:00', '07:00'].includes(start) && ['14:00', '15:00'].includes(end))
  ) return 'morning';
  return null;
};

const withOfficialShiftTimes = (shift) => {
  const role = ROTATION_ROLES.find((item) => item.key === roleKeyForShift(shift));
  if (!role) return shift;
  const [, startTime, endTime] = role.defaults;
  return { ...shift, start_time: startTime, end_time: endTime };
};

const ensureTemplateForRole = async (client, template, role, userId) => {
  const [name, startTime, endTime, color] = role.defaults;
  if (template) {
    const { rows } = await client.query(
      `UPDATE shift_templates
       SET start_time = $1,
           end_time = $2,
           color = COALESCE(color, $3),
           is_active = TRUE,
           updated_by = $4
       WHERE id = $5
       RETURNING id, name, start_time, end_time, color`,
      [startTime, endTime, color, userId, template.id]
    );
    return rows[0];
  }

  const { rows } = await client.query(
    `INSERT INTO shift_templates (id, name, start_time, end_time, color, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (name) DO UPDATE SET
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       color = EXCLUDED.color,
       is_active = TRUE,
       updated_by = EXCLUDED.updated_by
     RETURNING id, name, start_time, end_time, color`,
    [newId(), name, startTime, endTime, color, userId]
  );
  return rows[0];
};

const findAvailableReplacement = async (client, { employeeId, date }) => {
  const { rows } = await client.query(
    `SELECT e.id
     FROM employees e
     WHERE e.status = 'ACTIVE'
       AND e.id <> $1
       AND NOT EXISTS (
         SELECT 1 FROM vacation_requests vr
         WHERE vr.employee_id = e.id
           AND vr.status = 'APPROVED'
           AND vr.start_date <= $2::date
           AND vr.end_date >= $2::date
       )
       AND NOT EXISTS (
         SELECT 1 FROM shift_assignments sa
         WHERE sa.employee_id = e.id
           AND sa.date = $2::date
       )
     ORDER BY e.last_name ASC, e.first_name ASC
     LIMIT 1`,
    [employeeId, date]
  );
  return rows[0]?.id || null;
};

const findRestReplacementAssignment = async (client, { employeeId, date }) => {
  const { rows } = await client.query(
    `SELECT sa.id, sa.employee_id, st.name AS shift_name, st.start_time, st.end_time
     FROM shift_assignments sa
     JOIN shift_templates st ON st.id = sa.shift_template_id
     WHERE sa.date = $2::date
       AND sa.employee_id <> $1
       AND NOT EXISTS (
         SELECT 1 FROM vacation_requests vr
         WHERE vr.employee_id = sa.employee_id
           AND vr.status = 'APPROVED'
           AND vr.start_date <= $2::date
           AND vr.end_date >= $2::date
       )
     ORDER BY sa.created_at ASC
     FOR UPDATE OF sa`,
    [employeeId, date]
  );
  return rows.find((assignment) => roleKeyForShift({ shift_name: assignment.shift_name, name: assignment.name, start_time: assignment.start_time, end_time: assignment.end_time }) === 'rest') || null;
};

const reorganizeVacationAssignments = async (client, { employeeId, replacementEmployeeId, startDate, endDate, userId }) => {
  const { rows: affectedAssignments } = await client.query(
    `SELECT sa.id,
            sa.employee_id,
            sa.date::text AS date,
            sa.shift_template_id,
            st.name AS shift_name,
            st.start_time,
            st.end_time
     FROM shift_assignments sa
     JOIN shift_templates st ON st.id = sa.shift_template_id
     WHERE sa.employee_id = $1
       AND sa.date BETWEEN $2::date AND $3::date
     ORDER BY sa.date ASC
     FOR UPDATE OF sa`,
    [employeeId, startDate, endDate]
  );

  const result = { affected: affectedAssignments.length, reassigned: 0, removedRest: 0, unresolved: 0 };

  for (const assignment of affectedAssignments) {
    const date = toDateKey(assignment.date);
    const role = roleKeyForShift(assignment);

    if (role === 'rest') {
      await client.query('DELETE FROM shift_assignments WHERE id = $1', [assignment.id]);
      result.removedRest++;
      continue;
    }

    const replacementVacation = await client.query(
      `SELECT 1
       FROM vacation_requests
       WHERE employee_id = $1
         AND status = 'APPROVED'
         AND start_date <= $2::date
         AND end_date >= $2::date
       LIMIT 1`,
      [replacementEmployeeId, date]
    );
    if (replacementVacation.rows[0]) {
      throw new AppError('El guardia reemplazo está de vacaciones en una de las fechas afectadas', 400);
    }

    const replacementAssignment = await client.query(
      `SELECT sa.id, st.name AS shift_name, st.start_time, st.end_time
       FROM shift_assignments sa
       JOIN shift_templates st ON st.id = sa.shift_template_id
       WHERE sa.employee_id = $1
         AND sa.date = $2::date
       FOR UPDATE OF sa`,
      [replacementEmployeeId, date]
    );
    const existingReplacementAssignment = replacementAssignment.rows[0];

    if (existingReplacementAssignment) {
      const replacementRole = roleKeyForShift(existingReplacementAssignment);
      if (replacementRole !== 'rest') {
        throw new AppError('El guardia reemplazo ya tiene un turno operativo en una de las fechas afectadas', 400);
      }
      await client.query('DELETE FROM shift_assignments WHERE id = $1', [existingReplacementAssignment.id]);
      result.removedRest++;
    }

    await client.query(
      `UPDATE shift_assignments
       SET employee_id = $1,
           notes = $2,
           updated_by = $3
       WHERE id = $4`,
      [replacementEmployeeId, 'Reasignado por vacaciones', userId, assignment.id]
    );
    result.reassigned++;
  }

  return result;
};

// POST /shifts/rotation/generate
// Rotación de 4 guardias sobre 3 turnos diarios y 1 descanso visible.
// Cada día un guardia queda libre; quien sale de Noche descansa al día siguiente.
router.post('/rotation/generate', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const data = z.object({
    startDate: z.string().regex(DATE_RE),
    endDate: z.string().regex(DATE_RE),
    employeeIds: z.array(z.string()).length(GUARDS_PER_ROTATION),
    morningShiftTemplateId: z.string().optional(),
    afternoonShiftTemplateId: z.string().optional(),
    nightShiftTemplateId: z.string().optional(),
    restShiftTemplateId: z.string().optional(),
    overwrite: z.boolean().default(false),
  }).parse(req.body);

  if (data.startDate > data.endDate) {
    throw new AppError('La fecha inicial no puede ser posterior a la fecha final', 400);
  }
  if (new Set(data.employeeIds).size !== GUARDS_PER_ROTATION) {
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
    if (employees.rows.length !== GUARDS_PER_ROTATION) {
      throw new AppError('Los cuatro guardias seleccionados deben estar activos', 400);
    }

    const existing = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM shift_assignments
       WHERE date BETWEEN $1 AND $2`,
      [data.startDate, data.endDate]
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
      if (template) roleTemplates[role.key] = await ensureTemplateForRole(client, template, role, req.user.id);
    }

    // Las instalaciones antiguas podían no tener las plantillas base.
    // Solo se agregan las que falten; las plantillas elegidas por el usuario
    // se reutilizan con los horarios oficiales de la rotación.
    for (const role of ROTATION_ROLES) {
      if (roleTemplates[role.key]) continue;
      if (requestedTemplateIds[role.key]) {
        throw new AppError(`La plantilla seleccionada para ${role.key} no está activa o no existe`, 400);
      }
      const template = await ensureTemplateForRole(client, null, role, req.user.id);
      roleTemplates[role.key] = template;
      templates = [...templates, template];
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

    if (data.overwrite) {
      await client.query(
        `DELETE FROM shift_assignments WHERE date BETWEEN $1 AND $2`,
        [data.startDate, data.endDate]
      );
    }

    let count = 0;
    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      for (let roleIndex = 0; roleIndex < ROTATION_ROLES.length; roleIndex++) {
        const role = ROTATION_ROLES[roleIndex];
        // Con 4 guardias, esta rotación deja libre al guardia que
        // hizo Noche el día anterior y reparte 7 descansos semanales como
        // 2-2-2-1, rotando el guardia con un solo descanso cada semana.
        const employeeIndex = ((roleIndex - dayIndex) % data.employeeIds.length + data.employeeIds.length)
          % data.employeeIds.length;
        const employeeId = data.employeeIds[
          employeeIndex
        ];
        await client.query(
          `INSERT INTO shift_assignments (id, employee_id, shift_template_id, date, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (employee_id, date) DO UPDATE SET
             shift_template_id = EXCLUDED.shift_template_id,
             notes = NULL,
             updated_by = EXCLUDED.updated_by`,
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
    `SELECT sa.date::text AS date, sa.shift_template_id, e.first_name, e.last_name,
            st.name AS shift_name, st.start_time, st.end_time, st.color
     FROM shift_assignments sa
     JOIN employees e ON e.id = sa.employee_id
     JOIN shift_templates st ON st.id = sa.shift_template_id
     WHERE sa.date BETWEEN $1 AND $2
     ORDER BY sa.date, st.name, e.last_name, e.first_name`,
    [data.start, data.end]
  );
  const scheduleRows = rows.map(withOfficialShiftTimes);

  const requiredRoles = ROTATION_ROLES.map((role) => role.key);
  const incompleteDates = expectedDates.filter((date) => {
    const roles = new Set(scheduleRows
      .filter((assignment) => toDateKey(assignment.date) === date)
      .map(roleKeyForShift)
      .filter(Boolean));
    return requiredRoles.some((role) => !roles.has(role));
  });
  if (incompleteDates.length) {
    throw new AppError(
      `El horario aún está incompleto (${incompleteDates.length} día(s) sin mañana, tarde, noche y descanso).`,
      400
    );
  }

  const pdfRows = scheduleRows.filter((assignment) => roleKeyForShift(assignment));
  const pdfBuffer = await generateShiftSchedulePdf({
    startDate: data.start,
    endDate: data.end,
    assignments: pdfRows,
  });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="horario-guardias-${data.start}-${data.end}.pdf"`,
  });
  res.send(pdfBuffer);
});

module.exports = router;
