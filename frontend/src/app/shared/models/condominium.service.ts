import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import {
  AliquotPayment, BalanceReport, CondoConfig, CondoExpenseItem, CondoExpenseItemsResponse,
  CondoExpensePeriod, CondoFundEntry, CondoFundSummary, CondoOwner, CondoPeriodExpenseItem,
  MovementImportResult, OcrScanResult, PaymentExtra, ProvisionCatalogItem,
} from '../models/models';

@Injectable({ providedIn: 'root' })
export class CondominiumService extends ApiService {

  // Config
  getConfig(): Observable<CondoConfig> { return this.get('/condominium/config'); }
  saveConfig(data: Partial<CondoConfig>): Observable<CondoConfig> { return this.put('/condominium/config', data); }

  // Expense Items
  getExpenseItems(): Observable<CondoExpenseItemsResponse> { return this.get('/condominium/expense-items'); }
  createExpenseItem(data: Partial<CondoExpenseItem>): Observable<CondoExpenseItem> { return this.post('/condominium/expense-items', data); }
  updateExpenseItem(id: string, data: Partial<CondoExpenseItem>): Observable<CondoExpenseItem> { return this.put(`/condominium/expense-items/${id}`, data); }
  toggleExpenseItem(id: string): Observable<CondoExpenseItem> { return this.patch(`/condominium/expense-items/${id}/toggle`, {}); }
  deleteExpenseItem(id: string): Observable<void> { return this.delete(`/condominium/expense-items/${id}`); }

  // Owners
  getOwners(activeOnly = false): Observable<{ owners: CondoOwner[]; totalParticipationPct: number }> {
    return this.get('/condominium/owners', { activeOnly });
  }
  createOwner(data: Partial<CondoOwner>): Observable<CondoOwner> { return this.post('/condominium/owners', data); }
  importOwners(file: File): Observable<{ inserted: number; updated: number; errors: { row: number; unit: string; reason: string }[] }> {
    const fd = new FormData();
    fd.append('file', file);
    return this.postFormData('/condominium/owners/import', fd);
  }
  updateOwner(id: string, data: Partial<CondoOwner>): Observable<CondoOwner> { return this.patch(`/condominium/owners/${id}`, data); }
  toggleOwner(id: string): Observable<CondoOwner> { return this.patch(`/condominium/owners/${id}/toggle`, {}); }
  adjustMora(id: string, amount: number, operation: 'ADD' | 'SUBTRACT' | 'SET', notes?: string): Observable<CondoOwner> {
    return this.patch(`/condominium/owners/${id}/mora`, { amount, operation, notes });
  }

  // Periods
  getPeriods(): Observable<CondoExpensePeriod[]> { return this.get('/condominium/periods'); }
  getPeriod(id: string): Observable<CondoExpensePeriod> { return this.get(`/condominium/periods/${id}`); }
  getPeriodExpenseItems(id: string): Observable<CondoPeriodExpenseItem[]> { return this.get(`/condominium/periods/${id}/expense-items`); }
  createPeriod(data: {
    month: number;
    year: number;
    items?: { expenseItemId?: string | null; name?: string; category?: string; expenseType?: string; amount: number }[];
    variableExpenses?: number;
    variableNotes?: string;
    notes?: string;
    provisionIds?: string[];
    provisionAmounts?: Record<string, number>;
  }): Observable<CondoExpensePeriod> {
    return this.post('/condominium/periods', data);
  }
  updatePeriod(id: string, data: any): Observable<CondoExpensePeriod> { return this.patch(`/condominium/periods/${id}`, data); }
  generateAliquots(id: string): Observable<CondoExpensePeriod> { return this.post(`/condominium/periods/${id}/generate`, {}); }
  sendAliquotEmails(id: string): Observable<{ sent: number }> { return this.post(`/condominium/periods/${id}/send-emails`, {}); }
  closePeriod(id: string): Observable<CondoExpensePeriod> { return this.post(`/condominium/periods/${id}/close`, {}); }
  deletePeriod(id: string): Observable<void> { return this.delete(`/condominium/periods/${id}`); }

  // Payments
  getPayments(filters?: { ownerId?: string; periodId?: string; status?: string }): Observable<AliquotPayment[]> {
    return this.get('/condominium/payments', filters);
  }
  getPayment(id: string): Observable<AliquotPayment> { return this.get(`/condominium/payments/${id}`); }

  registerPayment(id: string, data: { amountPaid: number; paymentDate: string; paymentMonth: string; notes?: string }): Observable<AliquotPayment> {
    return this.post(`/condominium/payments/${id}/register`, {
      paidAmount: data.amountPaid,
      paymentDate: data.paymentDate,
      notes: data.notes,
    });
  }

  uploadProof(paymentId: string, file: File, moraPaymentRecordIds?: string[]): Observable<AliquotPayment> {
    const formData = new FormData();
    formData.append('file', file);
    if (moraPaymentRecordIds?.length) formData.append('moraPaymentRecordIds', JSON.stringify(moraPaymentRecordIds));
    return this.postFormData(`/condominium/payments/${paymentId}/proof`, formData);
  }

  registerMoraPayment(ownerId: string, file: File, data: { amount: number; paymentDate: string; notes?: string }): Observable<any> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('amount', String(data.amount));
    formData.append('paymentDate', data.paymentDate);
    if (data.notes) formData.append('notes', data.notes);
    return this.postFormData(`/condominium/owners/${ownerId}/mora/payments`, formData);
  }

  scanPaymentProof(file: File, periodId: string): Observable<OcrScanResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('periodId', periodId);
    return this.postFormData('/condominium/ocr/scan', formData);
  }

  importMovementPdf(file: File, periodId: string): Observable<MovementImportResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('periodId', periodId);
    return this.postFormData('/condominium/movements/scan', formData);
  }

  confirmOcrPayment(paymentId: string, file: File | null, data: {
    amount: number; paymentDate: string; ocrSenderName?: string | null; ocrBank?: string | null;
    movementProofUrl?: string; movementProofPublicId?: string;
  }): Observable<AliquotPayment> {
    const formData = new FormData();
    if (file) formData.append('file', file);
    formData.append('amount', String(data.amount));
    formData.append('paymentDate', data.paymentDate);
    if (data.ocrSenderName) formData.append('ocrSenderName', data.ocrSenderName);
    if (data.ocrBank) formData.append('ocrBank', data.ocrBank);
    if (data.movementProofUrl) formData.append('movementProofUrl', data.movementProofUrl);
    if (data.movementProofPublicId) formData.append('movementProofPublicId', data.movementProofPublicId);
    return this.postFormData(`/condominium/payments/${paymentId}/ocr-confirm`, formData);
  }

  deleteProof(paymentId: string): Observable<AliquotPayment> {
    return this.delete(`/condominium/payments/${paymentId}/proof`);
  }

  // ── Extras CRUD ──────────────────────────────────────────
  addPaymentExtra(paymentId: string, amount: number, notes: string): Observable<any> {
    return this.post(`/condominium/payments/${paymentId}/extras`, { amount, notes });
  }

  updatePaymentExtra(extraId: string, amount: number, notes: string): Observable<any> {
    return this.patch(`/condominium/extras/${extraId}`, { amount, notes });
  }

  deletePaymentExtra(extraId: string): Observable<any> {
    return this.delete(`/condominium/extras/${extraId}`);
  }

  downloadPaymentPdf(paymentId: string): Observable<Blob> {
    return this.http.get(`${this.BASE}/condominium/payments/${paymentId}/pdf`, { responseType: 'blob' });
  }

  getMorosidadReport(): Observable<CondoOwner[]> { return this.get('/condominium/reports/morosidad'); }

  // Fondos de Reserva
  getFundSummary(): Observable<CondoFundSummary> { return this.get('/condominium/funds/summary'); }
  getFundEntries(provisionId?: string, limit = 100): Observable<CondoFundEntry[]> {
    return this.get('/condominium/fund-entries', provisionId ? { provision_id: provisionId, limit } : { limit });
  }
  createFundEntry(data: {
    provision_id: string; amount: number; entry_type: string;
    description: string; entry_date?: string; is_negative?: boolean;
  }): Observable<CondoFundEntry> { return this.post('/condominium/fund-entries', data); }

  // Catálogo de provisiones
  getProvisionCatalog(): Observable<ProvisionCatalogItem[]> { return this.get('/condominium/provision-catalog'); }
  createProvision(data: Partial<ProvisionCatalogItem> & { calcType: string }): Observable<ProvisionCatalogItem> {
    return this.post('/condominium/provision-catalog', data);
  }
  updateProvision(id: string, data: Partial<{ name: string; description: string; calcType: string; value: number; isActive: boolean; sortOrder: number }>): Observable<ProvisionCatalogItem> {
    return this.patch(`/condominium/provision-catalog/${id}`, data);
  }
  deleteProvision(id: string): Observable<void> { return this.delete(`/condominium/provision-catalog/${id}`); }

  // Libro de Ingresos y Egresos
  getBalanceReport(filters?: { year?: number; month_from?: number; month_to?: number }): Observable<BalanceReport> {
    return this.get('/condominium/reports/balance', filters);
  }
  downloadBalancePdf(filters?: { year?: number; month_from?: number; month_to?: number }): Observable<Blob> {
    const params = new URLSearchParams();
    if (filters?.year)       params.set('year',       String(filters.year));
    if (filters?.month_from) params.set('month_from', String(filters.month_from));
    if (filters?.month_to)   params.set('month_to',   String(filters.month_to));
    const qs = params.toString() ? `?${params}` : '';
    return this.http.get(`${this.BASE}/condominium/reports/balance/pdf${qs}`, { responseType: 'blob' });
  }
}
