const cron = require('node-cron');
const { query } = require('../config/db');
const { sendAnnouncementEmail, sendAliquotReminder } = require('../services/email.service');

const startCronJobs = () => {
  // ── Job 1: Enviar anuncios programados ──────────────────────
  // Corre cada minuto — busca anuncios SCHEDULED cuya scheduled_at <= ahora
  cron.schedule('* * * * *', async () => {
    try {
      const { rows: pending } = await query(
        `SELECT * FROM announcements
         WHERE status = 'SCHEDULED' AND scheduled_at <= NOW()`
      );

      for (const ann of pending) {
        let recipients = [];
        if (ann.target_all) {
          const { rows } = await query(
            `SELECT email, first_name, last_name FROM employees
             WHERE status = 'ACTIVE' AND email IS NOT NULL`
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
        console.log(`[cron] Comunicado enviado: "${ann.title}" → ${recipients.length} destinatarios`);
      }
    } catch (err) {
      console.error('[cron] Error en job de anuncios:', err.message);
    }
  });

  // ── Job 2: Recordatorio de alícuotas (día 5 de cada mes) ───
  cron.schedule('0 8 5 * *', async () => {
    console.log('[cron] Enviando recordatorios de alícuotas pendientes...');
    try {
      const { rows } = await query(
        `SELECT ap.*, o.name AS owner_name, o.email AS owner_email, o.unit_number,
                cep.month, cep.year
         FROM aliquot_payments ap
         JOIN condo_owners o ON o.id = ap.owner_id
         JOIN condo_expense_periods cep ON cep.id = ap.period_id
         WHERE ap.status IN ('PENDING', 'PARTIAL', 'OVERDUE')
           AND o.email IS NOT NULL`
      );

      for (const payment of rows) {
        await sendAliquotReminder(payment);
      }
      console.log(`[cron] Recordatorios enviados: ${rows.length}`);
    } catch (err) {
      console.error('[cron] Error en job de alícuotas:', err.message);
    }
  });

  // ── Job 3: Actualizar mora (cada lunes a las 7am) ──────────
  // Marca como OVERDUE los pagos vencidos del período anterior cerrado
  // y acumula mora a los propietarios si no han pagado
  cron.schedule('0 7 * * 1', async () => {
    console.log('[cron] Actualizando mora de propietarios...');
    try {
      // Obtener config de mora
      const cfgRes = await query('SELECT mora_rate, mora_enabled FROM condo_config LIMIT 1');
      const cfg    = cfgRes.rows[0];
      if (!cfg || !cfg.mora_enabled) return;

      // Propietarios con saldo vencido
      const { rows: overdue } = await query(
        `SELECT ap.owner_id, SUM(ap.aliquot_amount + ap.mora_at_billing - ap.paid_amount) AS pending
         FROM aliquot_payments ap
         JOIN condo_expense_periods cep ON cep.id = ap.period_id
         WHERE ap.status = 'OVERDUE' AND cep.status = 'CLOSED'
         GROUP BY ap.owner_id`
      );

      for (const row of overdue) {
        const moraIncrement = Math.round(parseFloat(row.pending) * parseFloat(cfg.mora_rate) * 100) / 100;
        if (moraIncrement > 0) {
          await query(
            `UPDATE condo_owners SET mora_amount = mora_amount + $1 WHERE id = $2`,
            [moraIncrement, row.owner_id]
          );
        }
      }
      console.log(`[cron] Mora actualizada para ${overdue.length} propietarios`);
    } catch (err) {
      console.error('[cron] Error en job de mora:', err.message);
    }
  });

  console.log('✓ Cron jobs activos (anuncios, alícuotas, mora)');
};

module.exports = { startCronJobs };
