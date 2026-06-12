const nodemailer = require('nodemailer');
const config     = require('../config/config');

const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.port === 465,
  auth: {
    user: config.email.user,
    pass: config.email.pass,
  },
});

const MONTHS_ES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// ── Comunicados ───────────────────────────────────────────────

/**
 * Envía un comunicado a una lista de empleados.
 * @param {object} ann  — { title, body, type }
 * @param {Array}  recipients — [{ email, first_name, last_name }]
 */
const sendAnnouncementEmail = async (ann, recipients) => {
  const badge = ann.type === 'URGENT' ? '🔴 URGENTE' : ann.type === 'REMINDER' ? '🔔 Recordatorio' : 'ℹ️ Información';

  for (const r of recipients) {
    await transporter.sendMail({
      from:    `"RRHH Admin" <${config.email.from}>`,
      to:      r.email,
      subject: `[${badge}] ${ann.title}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
          <h2 style="color:#1e40af">${ann.title}</h2>
          <p>Estimado/a <strong>${r.first_name} ${r.last_name}</strong>,</p>
          <div style="background:#f1f5f9;padding:16px;border-radius:8px;white-space:pre-wrap">${ann.body}</div>
          <hr style="margin-top:24px">
          <p style="font-size:12px;color:#64748b">Este mensaje fue generado automáticamente. No responda a este correo.</p>
        </div>
      `,
    });
  }
};

// ── Alícuotas ─────────────────────────────────────────────────

/**
 * Envía notificación de cobro de alícuota a un propietario.
 * @param {object} payment — { owner_name, owner_email, unit_number,
 *                             aliquot_amount, mora_at_billing, month, year }
 */
const sendAliquotEmail = async (payment) => {
  if (!payment.owner_email) return;

  const total = (parseFloat(payment.aliquot_amount) + parseFloat(payment.mora_at_billing)).toFixed(2);
  const monthName = MONTHS_ES[payment.month];

  await transporter.sendMail({
    from:    `"Condominio Admin" <${config.email.from}>`,
    to:      payment.owner_email,
    subject: `Cobro de Alícuota — ${monthName} ${payment.year}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <h2 style="color:#1e40af">Notificación de Cobro</h2>
        <p>Estimado/a <strong>${payment.owner_name}</strong> (Unidad <strong>${payment.unit_number}</strong>),</p>
        <p>Le informamos que su alícuota correspondiente al mes de <strong>${monthName} ${payment.year}</strong> está disponible:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#f1f5f9">
            <td style="padding:8px 12px;font-weight:bold">Alícuota</td>
            <td style="padding:8px 12px;text-align:right">$${parseFloat(payment.aliquot_amount).toFixed(2)}</td>
          </tr>
          ${parseFloat(payment.mora_at_billing) > 0 ? `
          <tr>
            <td style="padding:8px 12px;color:#ef4444">Mora pendiente</td>
            <td style="padding:8px 12px;text-align:right;color:#ef4444">$${parseFloat(payment.mora_at_billing).toFixed(2)}</td>
          </tr>` : ''}
          <tr style="background:#1e40af;color:white">
            <td style="padding:8px 12px;font-weight:bold">TOTAL A PAGAR</td>
            <td style="padding:8px 12px;text-align:right;font-weight:bold">$${total}</td>
          </tr>
        </table>
        <p>Por favor realice su pago puntualmente.</p>
        <hr style="margin-top:24px">
        <p style="font-size:12px;color:#64748b">Mensaje generado automáticamente.</p>
      </div>
    `,
  });
};

// ── Nómina ────────────────────────────────────────────────────

/**
 * Envía rol de pagos a un empleado.
 * @param {object} detail — detalle de nómina con datos del empleado
 * @param {Buffer} pdfBuffer
 */
const sendPayrollEmail = async (detail, pdfBuffer) => {
  if (!detail.email) return;

  const monthName = MONTHS_ES[detail.month];

  await transporter.sendMail({
    from:    `"RRHH Admin" <${config.email.from}>`,
    to:      detail.email,
    subject: `Rol de Pagos — ${monthName} ${detail.year}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <h2 style="color:#1e40af">Rol de Pagos</h2>
        <p>Estimado/a <strong>${detail.first_name} ${detail.last_name}</strong>,</p>
        <p>Adjunto encontrará su rol de pagos correspondiente al mes de <strong>${monthName} ${detail.year}</strong>.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr style="background:#f1f5f9">
            <td style="padding:8px 12px">Salario bruto</td>
            <td style="padding:8px 12px;text-align:right">$${parseFloat(detail.gross_pay).toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px">IESS empleado</td>
            <td style="padding:8px 12px;text-align:right;color:#ef4444">-$${parseFloat(detail.iess_employee).toFixed(2)}</td>
          </tr>
          <tr style="background:#1e40af;color:white">
            <td style="padding:8px 12px;font-weight:bold">Neto a recibir</td>
            <td style="padding:8px 12px;text-align:right;font-weight:bold">$${parseFloat(detail.net_pay).toFixed(2)}</td>
          </tr>
        </table>
        <hr style="margin-top:24px">
        <p style="font-size:12px;color:#64748b">Mensaje generado automáticamente.</p>
      </div>
    `,
    attachments: pdfBuffer
      ? [{ filename: `rol-${monthName}-${detail.year}.pdf`, content: pdfBuffer }]
      : [],
  });
};

// ── Recordatorio alícuotas ────────────────────────────────────

/**
 * Envía recordatorio genérico de alícuota pendiente.
 * Usado por el cron job del día 5.
 */
const sendAliquotReminder = async (payment) => {
  await sendAliquotEmail(payment);
};

module.exports = { sendAnnouncementEmail, sendAliquotEmail, sendPayrollEmail, sendAliquotReminder };
