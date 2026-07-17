const { Router } = require('express');
const { z }      = require('zod');
const { query, getClient } = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success, paginated } = require('../../utils/response');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { newId }  = require('../../utils/id');

const router = Router();
router.use(authenticate);

const requestSchema = z.object({
  employeeId:    z.string(),
  startDate:     z.string(),
  endDate:       z.string(),
  daysRequested: z.number().positive(),
  reason:        z.string().optional(),
});

// GET /vacations/requests
router.get('/requests', async (req, res) => {
  const page   = parseInt(req.query.page  || '1',  10);
  const limit  = parseInt(req.query.limit || '20', 10);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  const empId  = req.query.employeeId || null;

  const conditions = ['1=1'];
  const params     = [];
  let idx = 1;

  if (status) { conditions.push(`vr.status = $${idx}`); params.push(status); idx++; }
  if (empId)  { conditions.push(`vr.employee_id = $${idx}`); params.push(empId); idx++; }

  const where = conditions.join(' AND ');

  const countRes = await query(`SELECT COUNT(*) FROM vacation_requests vr WHERE ${where}`, params);
  const dataRes  = await query(
    `SELECT vr.*, e.first_name, e.last_name, e.cedula, e.position,
            d.name AS department_name
     FROM vacation_requests vr
     JOIN employees e ON e.id = vr.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ${where}
     ORDER BY vr.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  paginated(res, dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit);
});

// GET /vacations/balance/:employeeId
router.get('/balance/:employeeId', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM vacation_balances WHERE employee_id = $1',
    [req.params.employeeId]
  );
  if (!rows[0]) throw new AppError('Saldo no encontrado', 404);
  success(res, rows[0]);
});

// POST /vacations/requests
router.post('/requests', async (req, res) => {
  const data = requestSchema.parse(req.body);

  // Verificar saldo disponible
  const balRes = await query(
    'SELECT available_days FROM vacation_balances WHERE employee_id = $1',
    [data.employeeId]
  );
  if (!balRes.rows[0]) throw new AppError('Empleado sin saldo de vacaciones', 404);
  if (balRes.rows[0].available_days < data.daysRequested) {
    throw new AppError('Saldo insuficiente de vacaciones', 400);
  }

  const { rows } = await query(
    `INSERT INTO vacation_requests
       (id, employee_id, start_date, end_date, days_requested, reason, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
    [newId(), data.employeeId, data.startDate, data.endDate, data.daysRequested, data.reason || null, req.user.id]
  );
  success(res, rows[0], 201, 'Solicitud creada');
});

// PATCH /vacations/requests/:id/review
router.patch('/requests/:id/review', authorize('ADMIN', 'HR', 'SUPERVISOR'), async (req, res) => {
  const { status, reviewNotes } = z.object({
    status:      z.enum(['APPROVED', 'REJECTED']),
    reviewNotes: z.string().optional(),
  }).parse(req.body);

  const reqRes = await query('SELECT * FROM vacation_requests WHERE id = $1', [req.params.id]);
  const vr = reqRes.rows[0];
  if (!vr) throw new AppError('Solicitud no encontrada', 404);
  if (vr.status !== 'PENDING') throw new AppError('La solicitud ya fue procesada', 400);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Verificar y bloquear el saldo dentro de la transacción para evitar race conditions
    const balRes = await client.query(
      'SELECT available_days FROM vacation_balances WHERE employee_id = $1 FOR UPDATE',
      [vr.employee_id]
    );
    if (!balRes.rows[0]) throw new AppError('Empleado sin saldo de vacaciones', 404);
    if (status === 'APPROVED' && parseFloat(balRes.rows[0].available_days) < parseFloat(vr.days_requested)) {
      throw new AppError('Saldo de vacaciones insuficiente al momento de aprobar', 400);
    }

    await client.query(
      `UPDATE vacation_requests SET
         status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3,
         updated_by = $2
       WHERE id = $4`,
      [status, req.user.id, reviewNotes || null, req.params.id]
    );

    if (status === 'APPROVED') {
      await client.query(
        `UPDATE vacation_balances SET
           available_days = available_days - $1,
           used_days      = used_days      + $1,
           updated_by     = $2
         WHERE employee_id = $3`,
        [vr.days_requested, req.user.id, vr.employee_id]
      );
    }

    await client.query('COMMIT');
    success(res, null, 200, `Solicitud ${status === 'APPROVED' ? 'aprobada' : 'rechazada'}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /vacations/accrue — acumular días manualmente (admin)
router.post('/accrue', authorize('ADMIN', 'HR'), async (req, res) => {
  const { employeeId, days } = z.object({
    employeeId: z.string(),
    days:       z.number().positive(),
  }).parse(req.body);

  const { rows } = await query(
    `UPDATE vacation_balances SET
       available_days    = available_days + $1,
       accrued_days      = accrued_days   + $1,
       last_accrual_date = NOW(),
       updated_by        = $2
     WHERE employee_id = $3 RETURNING *`,
    [days, req.user.id, employeeId]
  );
  if (!rows[0]) throw new AppError('Empleado no encontrado', 404);
  success(res, rows[0], 200, `${days} días acumulados`);
});

module.exports = router;
