export type CalcType   = 'PERCENTAGE' | 'FIXED';
export type Payer      = 'EMPLOYER' | 'EMPLOYEE';
export type Recipient  = 'IESS' | 'EMPLOYEE' | 'OTHER';
export type PayoutMode = 'IESS' | 'EMPLOYEE' | 'MONTHLY';
export type PaymentMode = 'MONTHLY' | 'LUMP_SUM';

export interface ObligationCatalogItem {
  id:            string;
  code:          string;
  name:          string;
  description:   string | null;
  calc_type:     CalcType;
  default_value: number | null;
  payer:         Payer;
  recipient:     Recipient;
  is_system:     boolean;
  is_active:     boolean;
  display_order: number;
  payment_mode:  PaymentMode;
  payment_month: number | null;
  payment_day:   number | null;
  created_at:    string;
  updated_at:    string;
}

export interface EmployeeObligationValue {
  obligation_id:  string;
  code:           string;
  name:           string;
  description:    string | null;
  calc_type:      CalcType;
  default_value:  number | null;
  payer:          Payer;
  recipient:      Recipient;
  is_system:      boolean;
  is_active:      boolean;
  override_value: number | null;
  payout_mode:    PayoutMode | null;
  prefer_monthly: boolean;
  notes:          string | null;
  effective_value: number;
}

export interface EmployeeObligationsSummary {
  employee_id:           string;
  obligations:           EmployeeObligationValue[];
  fondos_reserva_aplica: boolean;
  iess_quirografario:    number;
  iess_hipotecario:      number;
  notes:                 string | null;
}

export interface ObligationUpsertItem {
  obligation_id:  string;
  is_active:      boolean;
  override_value: number | null;
  payout_mode:    PayoutMode | null;
  prefer_monthly: boolean;
  notes:          string | null;
}

export interface ObligationPaymentRecord {
  id:                 string;
  employee_id:        string;
  first_name:         string;
  last_name:          string;
  cedula:             string;
  obligation_id:      string;
  obligation_name:    string;
  obligation_code:    string;
  payroll_period_id:  string;
  period_month:       number;
  period_year:        number;
  installment_num:    number;
  total_installments: number;
  amount:             number;
  created_at:         string;
}
