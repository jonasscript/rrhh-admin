import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AliquotPayment, CondoConfig, CondoExpensePeriod, CondoOwner } from '../models/models';

@Injectable({ providedIn: 'root' })
export class CondominiumService extends ApiService {

  // Config
  getConfig(): Observable<CondoConfig> { return this.get('/condominium/config'); }
  saveConfig(data: Partial<CondoConfig>): Observable<CondoConfig> { return this.put('/condominium/config', data); }

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
  createPeriod(data: { month: number; year: number; variableExpenses: number; variableNotes?: string }): Observable<CondoExpensePeriod> {
    return this.post('/condominium/periods', data);
  }
  updatePeriod(id: string, data: any): Observable<CondoExpensePeriod> { return this.patch(`/condominium/periods/${id}`, data); }
  generateAliquots(id: string): Observable<CondoExpensePeriod> { return this.post(`/condominium/periods/${id}/generate`, {}); }
  sendAliquotEmails(id: string): Observable<{ sent: number }> { return this.post(`/condominium/periods/${id}/send-emails`, {}); }
  closePeriod(id: string): Observable<CondoExpensePeriod> { return this.post(`/condominium/periods/${id}/close`, {}); }

  // Payments
  getPayments(filters?: { ownerId?: string; periodId?: string; status?: string }): Observable<AliquotPayment[]> {
    return this.get('/condominium/payments', filters);
  }
  getPayment(id: string): Observable<AliquotPayment> { return this.get(`/condominium/payments/${id}`); }

  registerPayment(id: string, data: { amountPaid: number; paymentDate: string; paymentMonth: string; notes?: string }): Observable<AliquotPayment> {
    return this.patch(`/condominium/payments/${id}/register`, data);
  }

  uploadProof(paymentId: string, file: File): Observable<AliquotPayment> {
    const formData = new FormData();
    formData.append('proof', file);
    return this.postFormData(`/condominium/payments/${paymentId}/proof`, formData);
  }

  deleteProof(paymentId: string): Observable<AliquotPayment> {
    return this.delete(`/condominium/payments/${paymentId}/proof`);
  }

  downloadPaymentPdf(paymentId: string): Observable<Blob> {
    return this.http.get(`${this.BASE}/condominium/payments/${paymentId}/pdf`, { responseType: 'blob' });
  }

  getMorosidadReport(): Observable<CondoOwner[]> { return this.get('/condominium/reports/morosidad'); }
}
