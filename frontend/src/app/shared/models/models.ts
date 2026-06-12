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
export interface CondoConfig { id: string; condoName: string; address?: string; fixedExpenses: number; adminEmail: string; }
export interface CondoOwner {
  id: string; fullName: string; apartmentNumber: string; email: string; phone?: string;
  participationPct: number; moraAmount: number; isActive: boolean; createdAt: string;
}
export interface CondoExpensePeriod {
  id: string; month: number; year: number;
  fixedExpenses: number; variableExpenses: number; totalExpenses: number;
  variableNotes?: string; status: PeriodStatus;
  createdAt: string; closedAt?: string;
  aliquotPayments?: AliquotPayment[];
  _count?: { aliquotPayments: number };
}

export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';
export interface AliquotPayment {
  id: string; periodId: string; ownerId: string;
  aliquotAmount: number; moraAtBilling: number; totalDue: number;
  amountPaid: number; paymentDate?: string; paymentMonth?: string;
  proofUrl?: string; proofPublicId?: string;
  status: PaymentStatus; notes?: string;
  createdAt: string; updatedAt: string;
  owner?: CondoOwner;
  period?: CondoExpensePeriod;
}
