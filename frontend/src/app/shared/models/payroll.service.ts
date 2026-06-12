import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class PayrollService {
  private base = `${environment.apiUrl}/payroll`;

  constructor(private http: HttpClient) {}

  listPeriods() {
    return this.http.get<any>(`${this.base}/periods`);
  }

  getPeriod(id: string) {
    return this.http.get<any>(`${this.base}/periods/${id}`);
  }

  createPeriod(data: { month: number; year: number }) {
    return this.http.post<any>(`${this.base}/periods`, data);
  }

  listDetails(periodId: string) {
    return this.http.get<any>(`${this.base}/periods/${periodId}/details`);
  }

  listDetailsByEmployee(employeeId: string) {
    return this.http.get<any>(`${this.base}/details?employeeId=${employeeId}`);
  }

  generate(periodId: string) {
    return this.http.post<any>(`${this.base}/periods/${periodId}/generate`, {});
  }

  updateDetail(periodId: string, employeeId: string, data: any) {
    return this.http.put<any>(`${this.base}/periods/${periodId}/details/${employeeId}`, data);
  }

  close(periodId: string) {
    return this.http.post<any>(`${this.base}/periods/${periodId}/close`, {});
  }

  downloadPdf(detailId: string) {
    return this.http.get(`${this.base}/details/${detailId}/pdf`, { responseType: 'blob' });
  }
}
