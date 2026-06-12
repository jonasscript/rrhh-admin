// ── Constantes Ecuador (Costa / Galápagos) ────────────────────
const IESS_EMPLOYEE = 0.0945;   // 9.45%
const IESS_EMPLOYER = 0.1115;   // 11.15%
const OVERTIME_SUPP_FACTOR = 1.50;  // suplementaria
const OVERTIME_EXTR_FACTOR = 2.00;  // extraordinaria

/**
 * Calcula el salario por hora dado un salario mensual.
 * Fórmula: salario / 30 / 8
 */
const hourlyRate = (monthlySalary) => monthlySalary / 30 / 8;

/**
 * Calcula si corresponden fondos de reserva.
 * A partir del mes 13 de relación laboral.
 * @param {Date} startDate
 * @param {number} month  — mes del período (1-12)
 * @param {number} year   — año del período
 */
const hasFondosReserva = (startDate, month, year) => {
  const periodDate = new Date(year, month - 1, 1);
  const start = new Date(startDate);
  const monthsDiff =
    (periodDate.getFullYear() - start.getFullYear()) * 12 +
    (periodDate.getMonth()    - start.getMonth());
  return monthsDiff >= 12;
};

/**
 * Calcula el detalle de nómina para un empleado en un período.
 *
 * Los valores de Décimo Tercero, Décimo Cuarto y Fondo de Reserva
 * provienen del catálogo de obligaciones en lugar de estar quemados.
 *
 * @param {object} employee         — { id, base_salary, start_date, iess_affiliate, fondos_reserva_aplica }
 * @param {number} month            — mes del período (1-12)
 * @param {number} year             — año del período
 * @param {number} workedDays       — días trabajados (default 30)
 * @param {number} overtimeSuppHours — horas suplementarias
 * @param {number} overtimeExtrHours — horas extraordinarias
 * @param {number} loanDiscount     — descuento por préstamo
 * @param {number} iessLoansDiscount — descuento préstamos IESS (quiro + hipot)
 * @param {number} otherDiscounts   — otros descuentos
 *
 * — Valores del catálogo —
 * @param {number} decimoTerceroRate   — tasa 13.° sueldo (ej. 0.0833 = 1/12)
 * @param {number} decimoCuartoAmount  — monto fijo mensual del 14.° sueldo (ej. SBU/12)
 * @param {number} fondosReservaRate   — tasa fondos reserva (ej. 0.0833 = 8.33%)
 * @param {string} fondosPayoutMode    — 'MONTHLY' | 'IESS'
 *   MONTHLY = empleador paga fondos directamente al empleado en la nómina
 *   IESS    = empleador remite fondos al IESS (no se incluye en pago al empleado)
 *
 * @returns {object} detalle de nómina
 */
const calculatePayroll = ({
  employee,
  month,
  year,
  workedDays        = 30,
  overtimeSuppHours = 0,
  overtimeExtrHours = 0,
  loanDiscount      = 0,
  iessLoansDiscount = 0,
  otherDiscounts    = 0,
  // Valores del catálogo (con defaults de seguridad)
  decimoTerceroRate  = 0.0833,
  decimoCuartoAmount = 38.33,
  fondosReservaRate  = 0.0833,
  fondosPayoutMode   = 'MONTHLY',
}) => {
  const baseSalary = parseFloat(employee.base_salary);
  const rate       = hourlyRate(baseSalary);

  // Salario proporcional por días trabajados
  const proportionalSalary = (baseSalary / 30) * workedDays;

  // Horas extras
  const suppPay = overtimeSuppHours * rate * (OVERTIME_SUPP_FACTOR - 1);
  const extrPay = overtimeExtrHours * rate * (OVERTIME_EXTR_FACTOR - 1);
  const overtimePay = round(suppPay + extrPay);

  // ── Fondos de Reserva: calcular PRIMERO (se usa como base para Décimo Tercero) ──
  const fondosReservaFlag = employee.fondos_reserva_aplica ?? false;
  const fondosApplies     = fondosReservaFlag || hasFondosReserva(employee.start_date, month, year);
  const fondosReserva     = fondosApplies ? round(baseSalary * fondosReservaRate) : 0;
  // MONTHLY = empleador paga fondos directamente al empleado en nómina
  // IESS    = empleador remite fondos al IESS (no se incluye en pago al empleado)
  const fondosEnNomina    = (fondosApplies && fondosPayoutMode === 'MONTHLY') ? fondosReserva : 0;

  // Total ganado al mes = salario proporcional + horas extra + fondo de reserva mensualizado
  // Este valor es la base para calcular el Décimo Tercero (ley ecuatoriana)
  const totalEarned = round(proportionalSalary + overtimePay + fondosEnNomina);

  // ── Décimo Tercero: 1/12 del total ganado al mes ─────────────────────────────
  const decimoTercero = round(totalEarned * decimoTerceroRate);

  // ── Décimo Cuarto: monto fijo mensual del catálogo (SBU vigente / 12) ────────
  const decimoCuarto = round(parseFloat(decimoCuartoAmount));

  // Ingreso bruto imponible (base para IESS — sin beneficios sociales)
  const grossForIESS = round(proportionalSalary + overtimePay);

  // Gross total (para el rol de pagos)
  const grossPay = round(grossForIESS + decimoTercero + decimoCuarto + fondosEnNomina);

  // IESS
  const iessEmployee = employee.iess_affiliate ? round(grossForIESS * IESS_EMPLOYEE) : 0;
  const iessEmployer = employee.iess_affiliate ? round(grossForIESS * IESS_EMPLOYER) : 0;

  // Neto al empleado
  const totalDiscounts = round(iessEmployee + loanDiscount + iessLoansDiscount + otherDiscounts);
  const netPay         = round(grossPay - totalDiscounts);

  return {
    baseSalary:        round(proportionalSalary),
    workedDays,
    overtimeSuppHours,
    overtimeExtrHours,
    overtimePay,
    decimoTercero,
    decimoCuarto,
    fondosReserva,      // monto calculado siempre registrado (para reportes)
    fondosPayoutMode,   // modo de pago — guardado en payroll_details
    iessEmployee,
    iessEmployer,
    loanDiscount:      round(loanDiscount),
    iessLoansDiscount: round(iessLoansDiscount),
    otherDiscounts:    round(otherDiscounts),
    grossPay,
    netPay,
  };
};

const round = (n) => Math.round(n * 100) / 100;

module.exports = { calculatePayroll, IESS_EMPLOYEE, IESS_EMPLOYER };
