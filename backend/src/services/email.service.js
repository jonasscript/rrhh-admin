const nodemailer = require('nodemailer');
const config     = require('../config/config');

const isOAuth2 = config.email.authMethod === 'OAUTH2';
const isGraph = config.email.delivery === 'GRAPH';
const outlookTokenUrl = config.email.oauth2.tokenUrl ||
  `https://login.microsoftonline.com/${config.email.oauth2.tenant}/oauth2/v2.0/token`;

const transporter = isGraph
  ? null
  : nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.port === 465,
      requireTLS: config.email.port === 587,
      auth: isOAuth2
        ? {
            type: 'OAuth2',
            user: config.email.user,
            clientId: config.email.oauth2.clientId,
            clientSecret: config.email.oauth2.clientSecret,
            refreshToken: config.email.oauth2.refreshToken,
            accessUrl: outlookTokenUrl,
          }
        : {
            user: config.email.user,
            pass: config.email.pass,
          },
    });

let graphTokenCache = { accessToken: '', expiresAt: 0 };

// EMAIL_FROM puede ser una dirección simple (correo@dominio.com) o una
// dirección RFC completa ("El Alcázar <correo@dominio.com>").
const fromAddress = (defaultName) => {
  const configured = String(config.email.from || config.email.user || '').trim();
  if (/<[^>]+>/.test(configured)) return configured;
  return configured ? `"${defaultName}" <${configured}>` : undefined;
};

const MONTHS_ES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const normalizeRecipients = (value) => String(value || '')
  .split(/[;,]/)
  .map(item => {
    const match = item.match(/<([^>]+)>/);
    return (match ? match[1] : item).trim();
  })
  .filter(Boolean)
  .map(address => ({ emailAddress: { address } }));

const getGraphAccessToken = async () => {
  if (graphTokenCache.accessToken && graphTokenCache.expiresAt > Date.now() + 60_000) {
    return graphTokenCache.accessToken;
  }

  const body = new URLSearchParams({
    client_id: config.email.oauth2.clientId,
    client_secret: config.email.oauth2.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: config.email.oauth2.refreshToken,
    scope: config.email.oauth2.graphScope,
  });

  const tokenResponse = await fetch(outlookTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(token.error_description || 'Microsoft Graph no devolvió un access token.');
  }

  graphTokenCache = {
    accessToken: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  return graphTokenCache.accessToken;
};

const sendGraphMail = async ({ to, subject, html, attachments = [] }) => {
  const accessToken = await getGraphAccessToken();
  const graphAttachments = attachments.map(attachment => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: attachment.filename,
    contentType: attachment.contentType || 'application/octet-stream',
    contentBytes: Buffer.isBuffer(attachment.content)
      ? attachment.content.toString('base64')
      : Buffer.from(String(attachment.content || '')).toString('base64'),
  }));

  const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: normalizeRecipients(to),
        ...(graphAttachments.length ? { attachments: graphAttachments } : {}),
      },
      saveToSentItems: true,
    }),
  });

  if (!graphResponse.ok) {
    let errorDetail = '';
    try {
      const errorBody = await graphResponse.json();
      errorDetail = errorBody.error?.message || JSON.stringify(errorBody);
    } catch (_) {
      errorDetail = await graphResponse.text();
    }
    throw new Error(`Microsoft Graph sendMail falló (${graphResponse.status}): ${errorDetail}`);
  }
};

const sendMail = async (message) => {
  if (isGraph) return sendGraphMail(message);
  return transporter.sendMail(message);
};

// ── Comunicados ───────────────────────────────────────────────

/**
 * Envía un comunicado a una lista de empleados.
 * @param {object} ann  — { title, body, type }
 * @param {Array}  recipients — [{ email, first_name, last_name }]
 */
const sendAnnouncementEmail = async (ann, recipients) => {
  const badge = ann.type === 'URGENT' ? '🔴 URGENTE' : ann.type === 'REMINDER' ? '🔔 Recordatorio' : 'ℹ️ Información';

  for (const r of recipients) {
    try {
      await sendMail({
        from:    fromAddress('HABBITA'),
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
    } catch (err) {
      console.error(`[email] Error al enviar comunicado a ${r.email}:`, err.message);
    }
  }
};

// ── Alícuotas ─────────────────────────────────────────────────

/**
 * Envía notificación de cobro de alícuota a un propietario.
 * @param {object} payment — { owner_name, owner_email, unit_number,
 *                             aliquot_amount, mora_at_billing, month, year }
 */
const sendAliquotEmail = async (payment, attachments = []) => {
  if (!payment.owner_email) return;

  const extrasTotal = Array.isArray(payment.extras)
    ? payment.extras.reduce((sum, extra) => sum + (parseFloat(extra.amount) || 0), 0)
    : 0;
  const moraAmount = Math.max(0, parseFloat(payment.owner_mora_amount ?? payment.mora_at_billing ?? 0) || 0);
  const periodTotal = (parseFloat(payment.aliquot_amount) + extrasTotal).toFixed(2);
  const monthName = MONTHS_ES[payment.month];

  await sendMail({
    from:    fromAddress('HABBITA'),
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
          ${extrasTotal > 0 ? `
          <tr>
            <td style="padding:8px 12px;color:#334155">Cargos extras</td>
            <td style="padding:8px 12px;text-align:right;color:#334155">$${extrasTotal.toFixed(2)}</td>
          </tr>` : ''}
          ${moraAmount > 0 ? `
          <tr>
            <td style="padding:8px 12px;color:#ef4444">Mora pendiente</td>
            <td style="padding:8px 12px;text-align:right;color:#ef4444">$${moraAmount.toFixed(2)}</td>
          </tr>
          <tr>
            <td colspan="2" style="padding:0 12px 8px;color:#64748b;font-size:12px">La mora se detalla por período pendiente en el PDF adjunto y no forma parte del valor del mes.</td>
          </tr>` : ''}
          <tr style="background:#1e40af;color:white">
            <td style="padding:8px 12px;font-weight:bold">TOTAL A PAGAR DEL MES</td>
            <td style="padding:8px 12px;text-align:right;font-weight:bold">$${periodTotal}</td>
          </tr>
        </table>
        <p>Por favor realice su pago puntualmente.</p>
        <hr style="margin-top:24px">
        <p style="font-size:12px;color:#64748b">Mensaje generado automáticamente.</p>
      </div>
    `,
    attachments,
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

  await sendMail({
    from:    fromAddress('HABBITA'),
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
