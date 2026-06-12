const { Router } = require('express');
const { z }      = require('zod');
const { query, getClient } = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success, paginated } = require('../../utils/response');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const { sendAnnouncementEmail } = require('../../services/email.service');
const { newId }  = require('../../utils/id');

const router = Router();
router.use(authenticate);

const announcementSchema = z.object({
  title:       z.string().min(3),
  body:        z.string().min(5),
  type:        z.enum(['INFO', 'URGENT', 'REMINDER']).default('INFO'),
  sendEmail:   z.boolean().default(false),
  targetAll:   z.boolean().default(true),
  recipientIds: z.array(z.string()).optional(),
  scheduledAt: z.string().optional().nullable(),
});

// GET /announcements
router.get('/', async (req, res) => {
  const page   = parseInt(req.query.page  || '1',  10);
  const limit  = parseInt(req.query.limit || '20', 10);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;

  const params = [];
  let idx = 1;
  let where = '1=1';
  if (status) { where += ` AND a.status = $${idx}`; params.push(status); idx++; }

  const countRes = await query(`SELECT COUNT(*) FROM announcements a WHERE ${where}`, params);
  const dataRes  = await query(
    `SELECT a.*, u.email AS created_by_email
     FROM announcements a
     LEFT JOIN users u ON u.id = a.created_by
     WHERE ${where}
     ORDER BY a.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  paginated(res, dataRes.rows, parseInt(countRes.rows[0].count, 10), page, limit);
});

// GET /announcements/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.email AS created_by_email FROM announcements a
     LEFT JOIN users u ON u.id = a.created_by
     WHERE a.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Comunicado no encontrado', 404);
  success(res, rows[0]);
});

// POST /announcements
router.post('/', authorize('ADMIN', 'HR'), async (req, res) => {
  const data = announcementSchema.parse(req.body);

  const status = data.scheduledAt ? 'SCHEDULED' : 'DRAFT';

  const { rows } = await query(
    `INSERT INTO announcements
       (id, title, body, type, status, send_email, target_all, scheduled_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      newId(),
      data.title, data.body, data.type, status,
      data.sendEmail, data.targetAll,
      data.scheduledAt || null, req.user.id,
    ]
  );

  const ann = rows[0];

  // Destinatarios específicos
  if (!data.targetAll && data.recipientIds?.length) {
    for (const empId of data.recipientIds) {
      await query(
        `INSERT INTO announcement_recipients (id, announcement_id, employee_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [newId(), ann.id, empId]
      );
    }
  }

  success(res, ann, 201, 'Comunicado creado');
});

// POST /announcements/:id/send — enviar inmediatamente
router.post('/:id/send', authorize('ADMIN', 'HR'), async (req, res) => {
  const annRes = await query(
    'SELECT * FROM announcements WHERE id = $1',
    [req.params.id]
  );
  const ann = annRes.rows[0];
  if (!ann) throw new AppError('Comunicado no encontrado', 404);
  if (ann.status === 'SENT') throw new AppError('El comunicado ya fue enviado', 400);

  let recipients = [];
  if (ann.target_all) {
    const { rows } = await query(
      `SELECT e.email, e.first_name, e.last_name
       FROM employees e WHERE e.status = 'ACTIVE' AND e.email IS NOT NULL`
    );
    recipients = rows;
  } else {
    const { rows } = await query(
      `SELECT e.email, e.first_name, e.last_name
       FROM announcement_recipients ar
       JOIN employees e ON e.id = ar.employee_id
       WHERE ar.announcement_id = $1 AND e.email IS NOT NULL`,
      [ann.id]
    );
    recipients = rows;
  }

  if (ann.send_email && recipients.length) {
    await sendAnnouncementEmail(ann, recipients);
  }

  await query(
    `UPDATE announcements SET status = 'SENT', sent_at = NOW() WHERE id = $1`,
    [ann.id]
  );

  success(res, null, 200, `Comunicado enviado a ${recipients.length} destinatarios`);
});

// DELETE /announcements/:id
router.delete('/:id', authorize('ADMIN'), async (req, res) => {
  const { rows } = await query(
    `DELETE FROM announcements WHERE id = $1 AND status != 'SENT' RETURNING id`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('No se puede eliminar este comunicado', 404);
  success(res, null, 200, 'Comunicado eliminado');
});

module.exports = router;
