const PDFDocument = require('pdfkit');

const MONTHS_ES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const fmt = (n) => `$${parseFloat(n || 0).toFixed(2)}`;
const roundMoney = (n) => Math.round((parseFloat(n || 0)) * 100) / 100;
const actualProvisionSavings = (expectedProvision, totalCollected, totalOperatingExpenses) => {
  const expected = parseFloat(expectedProvision) || 0;
  if (expected <= 0) return 0;
  const availableAfterExpenses = Math.max(
    0,
    (parseFloat(totalCollected) || 0) - (parseFloat(totalOperatingExpenses) || 0),
  );
  return roundMoney(Math.min(expected, availableAfterExpenses));
};

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
    const extrasTotal = Array.isArray(payment.extras)
      ? payment.extras.reduce((sum, extra) => sum + (parseFloat(extra.amount) || 0), 0)
      : 0;
    const total     = parseFloat(payment.aliquot_amount) + extrasTotal;

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
    if (Array.isArray(payment.extras) && payment.extras.length) {
      for (const extra of payment.extras) {
        row(doc, `Cargo extra: ${extra.notes || 'Sin detalle'}`, fmt(extra.amount));
      }
    }
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

/**
 * Genera un PDF del resumen mensual del propietario: total del período,
 * porcentaje, alícuota, cargos extras y total a pagar.
 * @param {object} opts — { payment, extras }
 * @returns {Promise<Buffer>}
 */
const generateOwnerExtrasPdf = ({ payment, extras = [] }) =>
  new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 40, size: 'A5' });
    const chunks = [];

    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const monthName = MONTHS_ES[payment.month];
    const totalExtras = extras.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const periodTotal = parseFloat(payment.grand_total) > 0
      ? parseFloat(payment.grand_total)
      : parseFloat(payment.total_expenses) || 0;
    const participationPct = parseFloat(payment.participation_pct) || 0;
    const aliquotAmount = parseFloat(payment.aliquot_amount) || 0;
    const totalToPay = aliquotAmount + totalExtras;

    doc.fontSize(16).fillColor('#1e40af').text('RESUMEN MENSUAL DEL PROPIETARIO', { align: 'center' });
    doc.fontSize(11).fillColor('#334155').text(`${monthName} ${payment.year}`, { align: 'center' });
    doc.moveDown();

    doc.fontSize(11).fillColor('#1e293b');
    doc.text(`Propietario: ${payment.owner_name}`);
    doc.text(`Unidad:      ${payment.unit_number}`);
    doc.moveDown();
    doc.moveTo(40, doc.y).lineTo(395, doc.y).stroke('#94a3b8');
    doc.moveDown(0.5);

    row(doc, 'Total del mes del período', fmt(periodTotal));
    row(doc, `Participación del propietario`, `${participationPct.toFixed(4)}%`);
    row(doc, 'Alícuota del mes', fmt(aliquotAmount));
    doc.moveDown(0.2);

    if (extras.length) {
      for (const extra of extras) {
        row(doc, `Cargo extra: ${extra.notes || 'Sin detalle'}`, fmt(extra.amount));
      }
    } else {
      row(doc, 'Cargos extras', fmt(0));
    }

    doc.moveTo(40, doc.y).lineTo(395, doc.y).stroke('#1e40af');
    doc.moveDown(0.3);
    doc.fontSize(13).fillColor('#1e40af');
    row(doc, 'TOTAL A PAGAR DEL MES', fmt(totalToPay), true);

    doc.end();
  });

/**
 * Genera el resumen del período que se crea/genera en condo-periods:
 * gastos fijos, variables, provisiones y total base de alícuotas.
 */
const generatePeriodSummaryPdf = ({ condoName, period, expenseItems = [], provisions = [] }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];

    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const monthName = MONTHS_ES[period.month];
    const fixedTotal = expenseItems
      .filter(item => item.expense_type === 'FIXED' || item.expenseType === 'FIXED')
      .reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const variableTotal = expenseItems
      .filter(item => item.expense_type === 'VARIABLE' || item.expenseType === 'VARIABLE')
      .reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const totalExpenses = parseFloat(period.total_expenses) || fixedTotal + variableTotal;
    const totalProvisions = parseFloat(period.total_provisions) || 0;
    const grandTotal = parseFloat(period.grand_total) > 0 ? parseFloat(period.grand_total) : totalExpenses + totalProvisions;

    doc.fontSize(16).fillColor('#1e40af').text('RESUMEN DEL PERÍODO', { align: 'center' });
    doc.fontSize(11).fillColor('#334155').text(condoName || 'Condominio', { align: 'center' });
    doc.fontSize(10).fillColor('#64748b').text(`${monthName} ${period.year}`, { align: 'center' });
    doc.moveDown();
    balanceDivider(doc, '#94a3b8');

    balanceHeading(doc, 'RESUMEN DE CÁLCULO');
    balanceRow(doc, 'Gastos fijos', fmt(fixedTotal));
    balanceRow(doc, 'Gastos variables', fmt(variableTotal));
    balanceRow(doc, 'Total gastos del período', fmt(totalExpenses), { bold: true });
    balanceRow(doc, 'Provisiones', fmt(totalProvisions));
    balanceRow(doc, 'Total base para alícuotas', fmt(grandTotal), { bold: true, color: '#1e40af' });

    if (period.notes || period.variable_notes) {
      doc.moveDown(0.3);
      if (period.notes) balanceRow(doc, 'Notas', String(period.notes), { labelColor: '#475569' });
      if (period.variable_notes) balanceRow(doc, 'Notas variables', String(period.variable_notes), { labelColor: '#475569' });
    }

    doc.moveDown(0.5);
    balanceHeading(doc, 'DETALLE DE GASTOS', '#f8fafc');
    if (expenseItems.length) {
      for (const item of expenseItems) {
        balanceRow(doc, item.name || 'Gasto', fmt(item.amount), {
          note: item.category || '',
          labelColor: '#475569',
        });
      }
    } else {
      balanceRow(doc, 'Sin gastos registrados', fmt(0), { labelColor: '#64748b' });
    }

    doc.moveDown(0.5);
    balanceHeading(doc, 'PROVISIONES', '#f8fafc');
    if (provisions.length) {
      for (const provision of provisions) {
        balanceRow(doc, provision.name || 'Provisión', fmt(provision.amount), { labelColor: '#475569' });
      }
    } else {
      balanceRow(doc, 'Sin provisiones aplicadas', fmt(0), { labelColor: '#64748b' });
    }

    doc.fontSize(8).fillColor('#94a3b8')
      .text(`Generado el ${new Date().toLocaleDateString('es-EC')}`, 40, 760, { align: 'right' });

    doc.end();
  });

/**
 * Genera el PDF para el correo de alícuota:
 * 1) resumen mensual del propietario;
 * 2) resumen de mora, solo si existe;
 * 3) resumen del período usado para calcular las alícuotas.
 */
const generateAliquotEmailSummaryPdf = ({ condoName, payment, extras = [], period, expenseItems = [], provisions = [], moraDebts = [] }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];

    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const monthName = MONTHS_ES[payment.month];
    const totalExtras = extras.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const periodTotal = parseFloat(payment.grand_total) > 0
      ? parseFloat(payment.grand_total)
      : parseFloat(payment.total_expenses) || 0;
    const participationPct = parseFloat(payment.participation_pct) || 0;
    const aliquotAmount = parseFloat(payment.aliquot_amount) || 0;
    const moraAmount = Math.max(0, parseFloat(payment.owner_mora_amount ?? payment.mora_at_billing ?? 0) || 0);
    const moraDebtsTotal = moraDebts.reduce((sum, debt) => sum + (parseFloat(debt.pending_amount ?? debt.pendingAmount) || 0), 0);
    const moraTotal = Math.max(moraAmount, moraDebtsTotal);
    const totalToPay = aliquotAmount + totalExtras;

    doc.fontSize(16).fillColor('#1e40af').text('RESUMEN MENSUAL DEL PROPIETARIO', { align: 'center' });
    doc.fontSize(11).fillColor('#334155').text(condoName || 'Condominio', { align: 'center' });
    doc.fontSize(10).fillColor('#64748b').text(`${monthName} ${payment.year}`, { align: 'center' });
    doc.moveDown();
    balanceDivider(doc, '#94a3b8');

    balanceHeading(doc, 'PROPIETARIO');
    balanceRow(doc, 'Propietario', payment.owner_name || 'Propietario');
    balanceRow(doc, 'Unidad', payment.unit_number || '—');
    balanceRow(doc, 'Total del mes del período', fmt(periodTotal));
    balanceRow(doc, 'Participación del propietario', `${participationPct.toFixed(4)}%`);
    balanceRow(doc, 'Alícuota del mes', fmt(aliquotAmount));

    doc.moveDown(0.4);
    balanceHeading(doc, 'CARGOS EXTRAS', '#f8fafc');
    if (extras.length) {
      for (const extra of extras) {
        balanceRow(doc, `Cargo extra: ${extra.notes || 'Sin detalle'}`, fmt(extra.amount), { labelColor: '#475569' });
      }
    } else {
      balanceRow(doc, 'Cargos extras', fmt(0), { labelColor: '#64748b' });
    }

    doc.moveDown(0.4);
    balanceDivider(doc, '#1e40af');
    balanceRow(doc, 'TOTAL A PAGAR DEL MES', fmt(totalToPay), { bold: true, color: '#1e40af' });
    doc.fontSize(8).fillColor('#94a3b8')
      .text(`Generado el ${new Date().toLocaleDateString('es-EC')}`, 40, 760, { align: 'right' });

    doc.addPage();

    if (moraTotal > 0) {
      doc.fontSize(16).fillColor('#dc2626').text('RESUMEN DE MORA PENDIENTE', { align: 'center' });
      doc.fontSize(11).fillColor('#334155').text(condoName || 'Condominio', { align: 'center' });
      doc.fontSize(10).fillColor('#64748b').text(payment.owner_name || 'Propietario', { align: 'center' });
      doc.moveDown();
      balanceDivider(doc, '#fca5a5');

      balanceHeading(doc, 'PERÍODOS PENDIENTES', '#fef2f2');
      if (moraDebts.length) {
        for (const debt of moraDebts) {
          const debtMonthName = MONTHS_ES[debt.month] || '';
          const debtLabel = debt.month && debt.year
            ? `${debtMonthName} ${debt.year}`
            : (debt.label || 'Mora sin período asociado');
          balanceRow(doc, debtLabel, fmt(debt.pending_amount ?? debt.pendingAmount), {
            note: debt.month && debt.year ? `Pagado ${fmt(debt.paid_amount ?? debt.amountPaid)}` : '',
            labelColor: '#475569',
            color: '#dc2626',
          });
        }
      } else {
        balanceRow(doc, 'Mora sin período asociado', fmt(moraTotal), {
          labelColor: '#475569',
          color: '#dc2626',
        });
      }

      doc.moveDown(0.4);
      balanceDivider(doc, '#dc2626');
      balanceRow(doc, 'TOTAL MORA PENDIENTE', fmt(moraTotal), { bold: true, color: '#dc2626' });
      doc.fontSize(8).fillColor('#94a3b8')
        .text(`Generado el ${new Date().toLocaleDateString('es-EC')}`, 40, 760, { align: 'right' });

      doc.addPage();
    }

    const periodMonthName = MONTHS_ES[period.month];
    const fixedTotal = expenseItems
      .filter(item => item.expense_type === 'FIXED' || item.expenseType === 'FIXED')
      .reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const variableTotal = expenseItems
      .filter(item => item.expense_type === 'VARIABLE' || item.expenseType === 'VARIABLE')
      .reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
    const totalExpenses = parseFloat(period.total_expenses) || fixedTotal + variableTotal;
    const totalProvisions = parseFloat(period.total_provisions) || 0;
    const grandTotal = parseFloat(period.grand_total) > 0 ? parseFloat(period.grand_total) : totalExpenses + totalProvisions;

    doc.fontSize(16).fillColor('#1e40af').text('RESUMEN DEL PERÍODO', { align: 'center' });
    doc.fontSize(11).fillColor('#334155').text(condoName || 'Condominio', { align: 'center' });
    doc.fontSize(10).fillColor('#64748b').text(`${periodMonthName} ${period.year}`, { align: 'center' });
    doc.moveDown();
    balanceDivider(doc, '#94a3b8');

    balanceHeading(doc, 'RESUMEN DE CÁLCULO');
    balanceRow(doc, 'Gastos fijos', fmt(fixedTotal));
    balanceRow(doc, 'Gastos variables', fmt(variableTotal));
    balanceRow(doc, 'Total gastos del período', fmt(totalExpenses), { bold: true });
    balanceRow(doc, 'Provisiones', fmt(totalProvisions));
    balanceRow(doc, 'Total base para alícuotas', fmt(grandTotal), { bold: true, color: '#1e40af' });

    doc.moveDown(0.5);
    balanceHeading(doc, 'DETALLE DE GASTOS', '#f8fafc');
    if (expenseItems.length) {
      for (const item of expenseItems) {
        balanceRow(doc, item.name || 'Gasto', fmt(item.amount), {
          note: item.category || '',
          labelColor: '#475569',
        });
      }
    } else {
      balanceRow(doc, 'Sin gastos registrados', fmt(0), { labelColor: '#64748b' });
    }

    doc.moveDown(0.5);
    balanceHeading(doc, 'PROVISIONES', '#f8fafc');
    if (provisions.length) {
      for (const provision of provisions) {
        balanceRow(doc, provision.name || 'Provisión', fmt(provision.amount), { labelColor: '#475569' });
      }
    } else {
      balanceRow(doc, 'Sin provisiones aplicadas', fmt(0), { labelColor: '#64748b' });
    }

    doc.fontSize(8).fillColor('#94a3b8')
      .text(`Generado el ${new Date().toLocaleDateString('es-EC')}`, 40, 760, { align: 'right' });

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

const balanceRow = (doc, label, value, opts = {}) => {
  const {
    bold = false,
    color = '#1e293b',
    labelColor = '#1e293b',
    indent = 0,
    note = '',
  } = opts;
  const y = doc.y;
  const left = 52 + indent;
  const labelText = note ? `${label} (${note})` : label;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor(labelColor);
  doc.text(labelText, left, y, { width: 350 });
  const labelEndY = doc.y;
  doc.y = y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor(color);
  doc.text(value, 440, y, { width: 105, align: 'right' });
  doc.y = Math.max(labelEndY, y + 12) + 4;
};

const balanceHeading = (doc, title, fill = '#eff6ff') => {
  const y = doc.y;
  doc.rect(40, y, 515, 22).fill(fill);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1e3a5f')
    .text(title, 52, y + 6, { width: 491 });
  doc.y = y + 30;
};

const balanceDivider = (doc, color = '#cbd5e1') => {
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke(color);
  doc.moveDown(0.45);
};

/**
 * Genera un PDF del Libro de Ingresos y Egresos (Balance General).
 * @param {object} opts — { condoName, periods, totalMora, year, month_from, month_to }
 * @returns {Promise<Buffer>}
 */
const generateBalancePdf = ({ condoName, periods, totalMora = 0, year, month_from, month_to }) =>
  new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];

    doc.on('data',  (c) => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ensureSpace = (height = 70) => {
      const bottom = doc.page.height - doc.page.margins.bottom - 24;
      if (doc.y + height > bottom) doc.addPage();
    };

    const periodLabel = year
      ? (month_from && month_to
          ? (+month_from === +month_to
              ? `Periodo ${MONTHS_ES[+month_from]} ${year}`
              : `${MONTHS_ES[+month_from]} a ${MONTHS_ES[+month_to]} ${year}`)
          : `Año ${year}`)
      : 'Todos los períodos';

    const totals = periods.reduce((acc, p) => {
      const totalBilled = parseFloat(p.total_billed) || 0;
      const totalCollected = parseFloat(p.total_collected) || 0;
      const totalExpenses = parseFloat(p.total_expenses) || 0;
      const totalAdminExpenses = Array.isArray(p.admin_expenses)
        ? p.admin_expenses.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0)
        : 0;
      const totalOperatingExpenses = totalExpenses + totalAdminExpenses;
      const totalProvisions = parseFloat(p.total_provisions) || 0;
      const realProvisionSavings = actualProvisionSavings(totalProvisions, totalCollected, totalOperatingExpenses);
      return {
        billed: acc.billed + totalBilled,
        collected: acc.collected + totalCollected,
        expenses: acc.expenses + totalExpenses,
        adminExpenses: acc.adminExpenses + totalAdminExpenses,
        operatingExpenses: acc.operatingExpenses + totalOperatingExpenses,
        expectedProvisions: acc.expectedProvisions + totalProvisions,
        actualProvisionSavings: acc.actualProvisionSavings + realProvisionSavings,
        result: acc.result + (totalCollected - totalOperatingExpenses),
      };
    }, {
      billed: 0,
      collected: 0,
      expenses: 0,
      adminExpenses: 0,
      operatingExpenses: 0,
      expectedProvisions: 0,
      actualProvisionSavings: 0,
      result: 0,
    });
    totals.pending = Math.max(0, totals.billed - totals.collected);
    totals.pendingProvisionSavings = Math.max(0, totals.expectedProvisions - totals.actualProvisionSavings);

    // Encabezado
    doc.fontSize(16).fillColor('#1e40af').text('INFORME FINANCIERO DEL CONDOMINIO', { align: 'center' });
    doc.fontSize(11).fillColor('#334155').text(condoName, { align: 'center' });
    doc.fontSize(10).fillColor('#64748b').text(periodLabel, { align: 'center' });
    doc.moveDown();
    balanceDivider(doc, '#94a3b8');

    balanceHeading(doc, 'BALANCE GENERAL DEL PERIODO');
    balanceRow(doc, 'Alícuotas generadas', fmt(totals.billed));
    balanceRow(doc, 'Ingresos cobrados', fmt(totals.collected), { color: '#16a34a' });
    balanceRow(doc, 'Pendiente del periodo consultado', fmt(totals.pending), { color: '#dc2626' });
    doc.moveDown(0.2);
    balanceRow(doc, 'Gastos de períodos', fmt(totals.expenses));
    balanceRow(doc, 'Gastos administrativos', fmt(totals.adminExpenses));
    balanceRow(doc, 'Total gastos reales', fmt(totals.operatingExpenses), { bold: true });
    doc.moveDown(0.2);
    balanceRow(doc, 'Provisión esperada del periodo', fmt(totals.expectedProvisions), { color: '#475569' });
    balanceRow(doc, 'Ahorro real después de gastos', fmt(totals.actualProvisionSavings), { color: '#16a34a' });
    balanceRow(doc, 'Provisión pendiente por cubrir', fmt(totals.pendingProvisionSavings), { color: totals.pendingProvisionSavings > 0 ? '#dc2626' : '#64748b' });
    doc.moveDown(0.2);
    balanceRow(doc, 'Resultado de caja', `${totals.result >= 0 ? '+' : ''}${fmt(totals.result)}`, {
      bold: true,
      color: totals.result >= 0 ? '#16a34a' : '#dc2626',
    });
    balanceRow(doc, 'Mora por cobrar', fmt(totalMora), { bold: true, color: '#dc2626' });
    doc.moveDown(0.5);

    // Detalle de periodos
    let cumulative = 0;
    for (const p of periods) {
      const total_billed    = parseFloat(p.total_billed) || 0;
      const total_collected = parseFloat(p.total_collected) || 0;
      const total_expenses  = parseFloat(p.total_expenses) || 0;
      const total_provisions= parseFloat(p.total_provisions) || 0;
      const adminExpenses   = Array.isArray(p.admin_expenses) ? p.admin_expenses : [];
      const total_admin_expenses = adminExpenses.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
      const total_operating_expenses = Math.round((total_expenses + total_admin_expenses) * 100) / 100;
      const balance         = Math.round((total_collected - total_operating_expenses) * 100) / 100;
      const expenseItems    = Array.isArray(p.expense_items) ? p.expense_items : [];
      const provisions      = Array.isArray(p.provisions) ? p.provisions : [];
      const pending         = Math.max(0, total_billed - total_collected);
      const realProvisionSavings = actualProvisionSavings(total_provisions, total_collected, total_operating_expenses);
      const pendingProvisionSavings = Math.max(0, total_provisions - realProvisionSavings);
      cumulative           += balance;

      ensureSpace(190);
      const periodName = `${MONTHS_ES[p.month]} ${p.year}`;
      balanceHeading(doc, periodName.toUpperCase(), '#f8fafc');

      doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Ingresos', 50);
      doc.moveDown(0.2);
      balanceRow(doc, 'Alícuotas generadas', fmt(total_billed), { indent: 10 });
      balanceRow(doc, 'Cobrado', fmt(total_collected), { indent: 10, color: '#16a34a' });
      balanceRow(doc, 'Por cobrar del periodo', fmt(pending), { indent: 10, color: pending > 0 ? '#dc2626' : '#64748b' });

      ensureSpace(50);
      doc.moveDown(0.1);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Gastos de períodos', 50);
      doc.moveDown(0.2);
      if (expenseItems.length) {
        for (const item of expenseItems) {
          ensureSpace(24);
          balanceRow(doc, item.name || 'Gasto', fmt(parseFloat(item.amount) || 0), {
            indent: 20,
            note: item.category || '',
            labelColor: '#475569',
          });
        }
      } else {
        balanceRow(doc, 'Gastos operativos sin desglose', fmt(total_expenses), { indent: 20, labelColor: '#64748b' });
      }
      balanceRow(doc, 'Total gastos de períodos', fmt(total_expenses), { bold: true, indent: 10 });

      ensureSpace(50);
      doc.moveDown(0.1);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Gastos administrativos reales', 50);
      doc.moveDown(0.2);
      if (adminExpenses.length) {
        for (const item of adminExpenses) {
          ensureSpace(24);
          balanceRow(doc, item.description || item.vendor || 'Gasto administrativo', fmt(parseFloat(item.amount) || 0), {
            indent: 20,
            note: item.vendor || item.category || '',
            labelColor: '#475569',
          });
        }
      } else {
        balanceRow(doc, 'Sin gastos administrativos registrados', fmt(0), { indent: 20, labelColor: '#64748b' });
      }
      balanceRow(doc, 'Total gastos administrativos', fmt(total_admin_expenses), { bold: true, indent: 10 });

      ensureSpace(50);
      doc.moveDown(0.1);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155').text('Provisión esperada y ahorro real', 50);
      doc.moveDown(0.2);
      if (provisions.length) {
        for (const provision of provisions) {
          ensureSpace(24);
          balanceRow(doc, provision.name || 'Provisión', fmt(parseFloat(provision.amount) || 0), {
            indent: 20,
            labelColor: '#475569',
          });
        }
      } else {
        balanceRow(doc, 'Meta de provisión sin desglose', fmt(total_provisions), { indent: 20, labelColor: '#64748b' });
      }
      balanceRow(doc, 'Meta total de provisión', fmt(total_provisions), { bold: true, indent: 10 });
      balanceRow(doc, 'Ahorro real después de gastos', fmt(realProvisionSavings), { bold: true, indent: 10, color: '#16a34a' });
      balanceRow(doc, 'Pendiente de ahorro por cubrir', fmt(pendingProvisionSavings), {
        indent: 10,
        color: pendingProvisionSavings > 0 ? '#dc2626' : '#64748b',
      });

      ensureSpace(86);
      doc.moveDown(0.1);
      balanceDivider(doc, '#e2e8f0');
      balanceRow(doc, 'Total gastos reales', fmt(total_operating_expenses), { bold: true });
      balanceRow(doc, 'Resultado de caja del periodo', `${balance >= 0 ? '+' : ''}${fmt(balance)}`, {
        bold: true,
        color: balance >= 0 ? '#16a34a' : '#dc2626',
      });
      balanceRow(doc, 'Resultado acumulado de caja', `${cumulative >= 0 ? '+' : ''}${fmt(cumulative)}`, {
        color: cumulative >= 0 ? '#16a34a' : '#dc2626',
      });
      doc.fillColor('#1e293b');
      doc.moveDown(0.3);
      balanceDivider(doc, '#cbd5e1');
    }

    // Cuentas por cobrar
    ensureSpace(86);
    balanceHeading(doc, 'CUENTAS POR COBRAR');
    balanceRow(doc, 'Mora por cobrar', fmt(totalMora), { bold: true, color: '#dc2626' });

    // Pie
    doc.fontSize(8).fillColor('#94a3b8')
       .text(`Generado el ${new Date().toLocaleDateString('es-EC')}`, 40, 760, { align: 'right' });

    doc.end();
  });

/**
 * Genera el horario de guardias por semanas, con la misma lectura visual del
 * archivo de rotación: turnos en filas y días en columnas.
 */
const generateShiftSchedulePdf = ({ startDate, endDate, assignments }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 28, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const normalize = (value) => String(value || '')
      .toLocaleLowerCase('es')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const roleFor = (assignment) => {
      const name = normalize(assignment.shift_name);
      const start = String(assignment.start_time || '').slice(0, 5);
      const end = String(assignment.end_time || '').slice(0, 5);
      if (name.includes('descanso')) return 'DESCANSO';
      if (name.includes('nocturno') || name.includes('noche') || (start === '21:00' && end === '07:00')) return 'NOCHE';
      if (name.includes('vespertino') || name.includes('tarde') || (start === '15:00' && end === '21:00')) return 'TARDE';
      if (name.includes('diurno') || name.includes('manana') || (start === '07:00' && end === '15:00')) return 'MAÑANA';
      return String(assignment.shift_name || 'TURNO').toUpperCase();
    };
    const roleOrder = ['MAÑANA', 'TARDE', 'NOCHE', 'DESCANSO'];
    const foundRoles = [...new Set(assignments.map(roleFor))];
    const roles = [
      ...roleOrder.filter((role) => foundRoles.includes(role)),
      ...foundRoles.filter((role) => !roleOrder.includes(role)),
    ];
    const byDateAndRole = new Map();
    const toDateKey = (value) => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value || '').slice(0, 10);
    };
    for (const assignment of assignments) {
      const key = `${toDateKey(assignment.date)}|${roleFor(assignment)}`;
      if (!byDateAndRole.has(key)) byDateAndRole.set(key, assignment);
    }

    const dateFromString = (value) => new Date(`${value}T12:00:00`);
    const start = dateFromString(startDate);
    const end = dateFromString(endDate);
    const firstMonday = new Date(start);
    firstMonday.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const lastSunday = new Date(end);
    lastSunday.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7) - 1));
    const weekdays = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'];
    const monthNames = MONTHS_ES;
    const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    doc.fontSize(17).fillColor('#1e3a5f').font('Helvetica-Bold')
      .text('HORARIO DE TURNOS — GUARDIAS', { align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#475569')
      .text(`${start.getDate()} de ${monthNames[start.getMonth() + 1]} al ${end.getDate()} de ${monthNames[end.getMonth() + 1]} de ${end.getFullYear()}`, { align: 'center' });
    doc.moveDown(1);

    const tableLeft = 28;
    const tableWidth = 786;
    const roleWidth = 90;
    const dayWidth = (tableWidth - roleWidth) / 7;
    let weekStart = new Date(firstMonday);

    while (weekStart <= lastSunday) {
      const rowHeight = 34;
      const sectionHeight = 22 + (roles.length * rowHeight) + 10;
      if (doc.y + sectionHeight > 560) doc.addPage();

      const days = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + index);
        return date;
      });
      const headerY = doc.y;
      doc.rect(tableLeft, headerY, roleWidth, 22).fill('#1e3a5f');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
        .text('TURNO', tableLeft, headerY + 7, { width: roleWidth, align: 'center' });
      for (let index = 0; index < days.length; index++) {
        const x = tableLeft + roleWidth + (index * dayWidth);
        const date = days[index];
        const inRange = date >= start && date <= end;
        doc.rect(x, headerY, dayWidth, 22).fill(inRange ? '#1e3a5f' : '#cbd5e1');
        doc.fillColor('#ffffff').fontSize(8)
          .text(inRange ? `${weekdays[index]} ${date.getDate()}` : '', x, headerY + 7, { width: dayWidth, align: 'center' });
      }

      for (let rowIndex = 0; rowIndex < roles.length; rowIndex++) {
        const y = headerY + 22 + (rowIndex * rowHeight);
        const role = roles[rowIndex];
        doc.rect(tableLeft, y, roleWidth, rowHeight).fill('#e2e8f0');
        doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(8)
          .text(role, tableLeft + 3, y + 12, { width: roleWidth - 6, align: 'center' });
        for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
          const x = tableLeft + roleWidth + (dayIndex * dayWidth);
          const date = days[dayIndex];
          const inRange = date >= start && date <= end;
          const assignment = inRange && byDateAndRole.get(`${formatDate(date)}|${role}`);
          doc.rect(x, y, dayWidth, rowHeight).fillAndStroke(inRange ? '#ffffff' : '#f8fafc', '#cbd5e1');
          if (assignment) {
            const employee = `${assignment.first_name} ${assignment.last_name}`.trim();
            doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(7)
              .text(employee, x + 3, y + 7, { width: dayWidth - 6, align: 'center' });
            if (role !== 'DESCANSO') {
              doc.font('Helvetica').fillColor('#64748b').fontSize(6)
                .text(`${String(assignment.start_time).slice(0, 5)}–${String(assignment.end_time).slice(0, 5)}`, x + 3, y + 19, { width: dayWidth - 6, align: 'center' });
            }
          }
        }
      }
      doc.y = headerY + 22 + (roles.length * rowHeight) + 10;
      weekStart.setDate(weekStart.getDate() + 7);
    }

    doc.fontSize(8).fillColor('#94a3b8')
      .text(`Generado el ${new Date().toLocaleDateString('es-EC')}`, { align: 'right' });
    doc.end();
  });

module.exports = {
  generatePayrollPdf,
  generateAliquotPdf,
  generateOwnerExtrasPdf,
  generatePeriodSummaryPdf,
  generateAliquotEmailSummaryPdf,
  generateBalancePdf,
  generateShiftSchedulePdf,
};
