// ── Auth ────────────────────────────────────────────────────
export interface LoginRequest { email: string; password: string; }
export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: { id: string; email: string; role: UserRole };
}
export type UserRole = 'ADMIN' | 'HR' | 'SUPERVISOR' | 'EMPLEADO';

// ── Shared ──────────────────────────────────────────────────
export interface ApiResponse<T> { success: boolean; message: string; data: T; }
export interface PaginatedResponse<T> {
  employees: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ── Employees ───────────────────────────────────────────────
export type ContractType = 'INDEFINIDO' | 'PLAZO_FIJO' | 'OBRA_CIERTA';
export type EmployeeStatus = 'ACTIVE' | 'VACATION' | 'INACTIVE';

export interface Department { id: string; name: string; _count?: { employees: number }; }
export interface Employee {
  id: string; firstName: string; lastName: string;
  cedula: string; phone?: string; address?: string;
  birthDate?: string; hireDate: string;
  contractType: ContractType; position: string;
  baseSalary: number; status: EmployeeStatus;
  departmentId: string; department: Department;
  user: { email: string; role: UserRole };
}

// ── Payroll ─────────────────────────────────────────────────
export type PeriodStatus = 'DRAFT' | 'APPROVED' | 'CLOSED';
export interface PayrollPeriod {
  id: string; month: number; year: number; status: PeriodStatus;
  createdAt: string; closedAt?: string;
  details?: PayrollDetail[];
  _count?: { details: number };
}
export interface PayrollDetail {
  id: string; periodId: string; employeeId: string;
  employee: Employee;
  baseSalary: number; extraHoursSupp: number; extraHoursExtr: number;
  extraHoursSuppAmount: number; extraHoursExtrAmount: number; otherBonuses: number;
  grossSalary: number; iessEmployee: number; loanDiscount: number;
  otherDiscounts: number; netSalary: number; iessEmployer: number;
  decimoTerceroAccum: number; decimoCuartoAccum: number;
  fondosReserva: number; vacacionesProvision: number; notes?: string;
}

// ── Vacations ───────────────────────────────────────────────
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export interface VacationBalance {
  id: string; employeeId: string; totalEarned: number; totalUsed: number; available: number;
  employee?: { firstName: string; lastName: string; hireDate: string };
}
export interface VacationRequest {
  id: string; employeeId: string; startDate: string; endDate: string;
  days: number; reason?: string; status: RequestStatus;
  reviewedBy?: string; reviewNotes?: string; createdAt: string;
  employee?: { firstName: string; lastName: string; department?: Department };
}

// ── Shifts ──────────────────────────────────────────────────
export interface ShiftTemplate { id: string; name: string; startTime: string; endTime: string; isNight: boolean; color: string; }
export interface ShiftAssignment {
  id: string; employeeId: string; shiftId: string; date: string; post?: string; notes?: string;
  employee?: { firstName: string; lastName: string; cedula: string };
  shift?: ShiftTemplate;
}

// ── Announcements ────────────────────────────────────────────
export type AnnouncementType = 'INFO' | 'URGENT' | 'REMINDER';
export type AnnouncementStatus = 'DRAFT' | 'SCHEDULED' | 'SENT';
export interface Announcement {
  id: string; title: string; body: string; type: AnnouncementType;
  scheduledAt?: string; sentAt?: string; status: AnnouncementStatus;
  createdBy: string; createdAt: string; _count?: { recipients: number };
}

// ── Condominium ──────────────────────────────────────────────
export interface CondoConfig {
  id: string;
  name: string;
  admin_email?: string;
  fixed_maintenance: number;
  fixed_security: number;
  fixed_cleaning: number;
  fixed_other: number;
  mora_enabled: boolean;
  mora_rate: number;
  mora_grace_days: number;
  capital_reserve_pct:  number;
  capital_reserve_type: 'PERCENTAGE' | 'FIXED';
  bad_debt_pct:         number;
  bad_debt_type:        'PERCENTAGE' | 'FIXED';
  created_at?: string;
  updated_at?: string;
}
export interface CondoOwner {
  id: string; fullName: string; apartmentNumber: string; email: string; phone?: string;
  participationPct: number; moraAmount: number; isActive: boolean; createdAt: string;
  overduePeriods?: number;
  debtPeriods?: CondoMoraPeriod[];
  moraPayments?: MoraPaymentRecord[];
}

export interface CondoMoraPeriod {
  periodId: string;
  paymentId: string;
  month: number;
  year: number;
  closedAt?: string;
  aliquotAmount: number;
  extrasTotal: number;
  amountPaid: number;
  pendingAmount: number;
}

export interface MoraPaymentRecord {
  id: string;
  ownerId?: string;
  debtPaymentId?: string;
  debtMonth?: number;
  debtYear?: number;
  debtTotalAmount?: number;
  debtCurrentPending?: number;
  amount: number;
  paymentDate: string;
  paymentType: 'ALIQUOT_EXCESS' | 'DIRECT';
  proofUrl?: string;
  notes?: string;
  createdAt: string;
}
export interface CondoExpensePeriod {
  id: string; month: number; year: number;
  fixed_maintenance: number; fixed_security: number; fixed_cleaning: number; fixed_other: number;
  variable_expenses: number; variable_notes?: string;
  total_expenses: number;
  capital_reserve: number;
  bad_debt_provision: number;
  total_provisions: number;
  grand_total: number;
  status: PeriodStatus; notes?: string;
  generated_at?: string; closed_at?: string;
  created_at: string; updated_at: string;
  total_payments?: number; paid_count?: number; total_collected?: number;
  payments?: AliquotPayment[];
}

export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';

export interface PaymentExtra {
  id: string;
  paymentId: string;
  amount: number;
  notes: string;
  createdAt: string;
}

export interface AliquotPayment {
  id: string; periodId: string; ownerId: string;
  aliquotAmount: number; moraAtBilling: number;
  extrasTotal: number;
  totalDue: number;
  amountPaid: number; paymentDate?: string;
  proofUrl?: string; proofPublicId?: string;
  /** Señala que este período estuvo vencido y luego fue cubierto como mora. */
  wasOverdue?: boolean;
  moraPaymentProofs?: Array<{
    id: string;
    amount: number;
    paymentDate: string;
    proofUrl?: string;
    notes?: string;
  }>;
  moraPaymentRecordIds?: string[];
  status: PaymentStatus; notes?: string;
  createdAt: string; updatedAt: string;
  owner?: CondoOwner;
  period?: CondoExpensePeriod;
  extras: PaymentExtra[];
}

export interface OcrExtractedData {
  raw_text?: string;
  payment_type?: string;
  amount?: number | null;
  currency?: string | null;
  date?: string | null;
  reference_number?: string | null;
  origin_account?: string | null;
  destination_account?: string | null;
  bank?: string | null;
  sender_name?: string | null;
  receiver_name?: string | null;
  confidence_score?: number | null;
  matched_template?: string | null;
}

export interface OcrOwnerMatch {
  paymentId: string;
  paymentStatus: PaymentStatus;
  aliquotAmount: number;
  moraAtBilling: number;
  amountPaid: number;
  totalDue: number;
  owner: Pick<CondoOwner, 'id' | 'fullName' | 'apartmentNumber'>;
}

export interface OcrScanResult {
  filename: string;
  extractedData: OcrExtractedData;
  matches: OcrOwnerMatch[];
  suggestedMatches?: OcrOwnerMatch[];
}

export interface MovementImportTransaction {
  id: string;
  paymentDate: string;
  amount: number;
  description: string;
  matches: OcrOwnerMatch[];
  suggestedMatches?: OcrOwnerMatch[];
}

export interface MovementImportResult {
  filename: string;
  proofUrl: string;
  proofPublicId: string;
  transactions: MovementImportTransaction[];
}

// ── Condominium Expense Items ────────────────────────────────
export type ExpenseCategory = 'MAINTENANCE' | 'SECURITY' | 'CLEANING' | 'UTILITIES' | 'ADMINISTRATION' | 'OTHER';
export type ExpenseType = 'FIXED' | 'VARIABLE';

export interface CondoExpenseItem {
  id: string;
  name: string;
  description?: string;
  category: ExpenseCategory;
  expenseType: ExpenseType;
  amount: number;
  isActive: boolean;
  isRecurring: boolean;
  displayOrder: number;
  createdAt: string;
}

export interface CondoExpenseItemsResponse {
  items: CondoExpenseItem[];
  totalFixed: number;
  totalVariable: number;
  total: number;
}

export interface CondoPeriodExpenseItem {
  id: string;
  expenseItemId?: string;
  name: string;
  category: ExpenseCategory;
  expenseType: ExpenseType;
  amount: number;
  notes?: string;
  createdAt: string;
}

// ── Fondos de Reserva ────────────────────────────────────────────────
export type FundEntryType = 'PROVISION' | 'EXPENDITURE' | 'WRITE_OFF' | 'ADJUSTMENT' | 'REVERSAL';

export interface ProvisionCatalogItem {
  id: string;
  name: string;
  description: string;
  calc_type: 'PERCENTAGE' | 'FIXED' | 'VARIABLE';
  value: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CondoFundEntry {
  id: string;
  fund_type: string;
  provision_id?: string;
  provision_name?: string;
  amount: number;
  entry_type: FundEntryType;
  period_id?: string;
  description: string;
  entry_date: string;
  registered_by?: string;
  registered_by_email?: string;
  running_balance?: number;
  created_at: string;
}

export interface CondoFundFacet {
  id: string;
  name: string;
  is_active: boolean;
  balance: number;
  last_entries: CondoFundEntry[];
}
export type CondoFundSummary = Record<string, CondoFundFacet>;

// ── Libro de Ingresos y Egresos ──────────────────────────────────
export interface BalancePeriodIngresos {
  total_billed: number; total_collected: number;
  total_payments: number; paid_count: number; collection_pct: number;
}
export interface BalancePeriodEgresos {
  items: { name: string; category: string; expense_type: string; amount: number }[];
  provisions: { provision_id?: string; name: string; amount: number }[];
  total_expenses: number; total_provisions: number; grand_total: number;
}
export interface BalancePeriodRow {
  period: { id: string; month: number; year: number; status: string; generated_at?: string };
  ingresos: BalancePeriodIngresos;
  egresos: BalancePeriodEgresos;
  fund_moves: CondoFundEntry[];
  balance: number;
  cumulative: number;
}
export interface BalanceReport {
  rows: BalancePeriodRow[];
  summary: { total_billed: number; total_collected: number; total_expenses: number;
             total_provisions: number; grand_total: number; net_result: number; };
  funds: Record<string, { name: string; balance: number }>;
}
