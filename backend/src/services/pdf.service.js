const PDFDocument = require('pdfkit');

const MONTHS_ES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const fmt = (n) => `$${parseFloat(n || 0).toFixed(2)}`;

/**
 * Genera un PDF de rol de pagos.
 * @param {object} detail — payroll_details + employee data + period month/year
 * @returns {Promise<Buffer>}
 */
const generatePayrollPdf = (detail) =>
  new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];

    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const monthName = MONTHS_ES[detail.month];

    // Encabezado
    doc.fontSize(18).fillColor('#1e40af').text('ROL DE PAGOS', { align: 'center' });
    doc.fontSize(12).fillColor('#334155').text(`${monthName} ${detail.year}`, { align: 'center' });
    doc.moveDown();

    // Datos del empleado
    doc.fontSize(11).fillColor('#1e293b');
    doc.text(`Empleado:    ${detail.first_name} ${detail.last_name}`);
    doc.text(`Cédula:      ${detail.cedula}`);
    doc.text(`Cargo:       ${detail.position}`);
    doc.text(`Departamento: ${detail.department_name || '—'}`);
    if (detail.bank_name) doc.text(`Banco:       ${detail.bank_name} — ${detail.bank_account || ''}`);
    doc.moveDown();

    // Línea separadora
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#94a3b8');
    doc.moveDown(0.5);

    // Ingresos
    section(doc, 'INGRESOS');
    row(doc, 'Salario base',       fmt(detail.base_salary));
    if (parseFloat(detail.overtime_pay) > 0)
      row(doc, `Horas extras (supl: ${detail.overtime_supp_hours}h / extr: ${detail.overtime_extr_hours}h)`, fmt(detail.overtime_pay));
    row(doc, 'Décimo tercero (provisión)',  fmt(detail.decimo_tercero));
    if (parseFloat(detail.decimo_cuarto) > 0)
      row(doc, 'Décimo cuarto (provisión)', fmt(detail.decimo_cuarto));
    if (parseFloat(detail.fondos_reserva) > 0)
      row(doc, 'Fondos de reserva', fmt(detail.fondos_reserva));
    totalRow(doc, 'TOTAL INGRESOS', fmt(detail.gross_pay));
    doc.moveDown(0.5);

    // Descuentos
    section(doc, 'DESCUENTOS');
    if (parseFloat(detail.iess_employee) > 0)
      row(doc, 'IESS empleado (9.45%)',  fmt(detail.iess_employee));
    if (parseFloat(detail.loan_discount) > 0)
      row(doc, 'Descuento préstamo',     fmt(detail.loan_discount));
    if (parseFloat(detail.other_discounts) > 0)
      row(doc, 'Otros descuentos',       fmt(detail.other_discounts));
    doc.moveDown(0.5);

    // Neto
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#1e40af');
    doc.moveDown(0.3);
    doc.fontSize(13).fillColor('#1e40af');
    row(doc, 'NETO A RECIBIR', fmt(detail.net_pay), true);
    doc.moveDown();

    // Aporte patronal informativo
    doc.fontSize(9).fillColor('#64748b');
    doc.text(`Aporte patronal IESS (11.15%): ${fmt(detail.iess_employer)}  — no afecta neto del empleado`);

    if (detail.notes) {
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#334155').text(`Notas: ${detail.notes}`);
    }

    doc.end();
  });

/**
 * Genera un PDF de comprobante de alícuota.
 * @param {object} payment — aliquot_payments + owner + period data
 * @returns {Promise<Buffer>}
 */
const generateAliquotPdf = (payment) =>
  new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 40, size: 'A5' });
    const chunks = [];

    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const monthName = MONTHS_ES[payment.month];
    const total     = parseFloat(payment.aliquot_amount) + parseFloat(payment.mora_at_billing);

    doc.fontSize(16).fillColor('#1e40af').text('COMPROBANTE DE ALÍCUOTA', { align: 'center' });
    doc.fontSize(11).fillColor('#334155').text(`${monthName} ${payment.year}`, { align: 'center' });
    doc.moveDown();

    doc.fontSize(11).fillColor('#1e293b');
    doc.text(`Propietario: ${payment.owner_name}`);
    doc.text(`Unidad:      ${payment.unit_number}`);
    doc.moveDown();

    doc.moveTo(40, doc.y).lineTo(395, doc.y).stroke('#94a3b8');
    doc.moveDown(0.5);

    row(doc, 'Alícuota del período', fmt(payment.aliquot_amount));
    if (parseFloat(payment.mora_at_billing) > 0)
      row(doc, 'Mora pendiente',  fmt(payment.mora_at_billing));

    doc.moveTo(40, doc.y).lineTo(395, doc.y).stroke('#1e40af');
    doc.moveDown(0.3);
    doc.fontSize(13).fillColor('#1e40af');
    row(doc, 'TOTAL', `$${total.toFixed(2)}`, true);

    doc.moveDown();
    doc.fontSize(11).fillColor('#334155');
    row(doc, 'Monto pagado', fmt(payment.paid_amount));
    row(doc, 'Estado', payment.status);
    if (payment.payment_date) row(doc, 'Fecha de pago', payment.payment_date);

    doc.end();
  });

// ── Helpers ───────────────────────────────────────────────────

const section = (doc, title) => {
  doc.fontSize(10).fillColor('#64748b').text(title.toUpperCase());
  doc.moveDown(0.3);
};

const row = (doc, label, value, bold = false) => {
  const y = doc.y;
  doc.fontSize(bold ? 12 : 10).fillColor(bold ? '#1e40af' : '#1e293b');
  doc.text(label, 50, y);
  doc.text(value, 0, y, { align: 'right' });
  doc.moveDown(0.4);
};

const totalRow = (doc, label, value) => {
  doc.fontSize(11).fillColor('#1e40af');
  doc.font('Helvetica-Bold');
  row(doc, label, value, true);
  doc.font('Helvetica');
};

module.exports = { generatePayrollPdf, generateAliquotPdf };
