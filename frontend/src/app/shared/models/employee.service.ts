import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { signal } from '@angular/core';
import { ObligationCatalogItem, ObligationUpsertItem } from './obligation.model';

@Injectable({ providedIn: 'root' })
export class EmployeeService {
  private base = `${environment.apiUrl}/employees`;
  private selectedEmployee = signal<any | null>(null);

  constructor(private http: HttpClient) {}

  setSelectedEmployee(employee: any | null) {
    this.selectedEmployee.set(employee);
  }

  getSelectedEmployee() {
    return this.selectedEmployee();
  }

  clearSelectedEmployee() {
    this.selectedEmployee.set(null);
  }

  list(params?: { page?: number; limit?: number; search?: string; status?: string; departmentId?: string }) {
    let p = new HttpParams();
    if (params?.page)         p = p.set('page',         params.page);
    if (params?.limit)        p = p.set('limit',        params.limit);
    if (params?.search)       p = p.set('search',       params.search);
    if (params?.status)       p = p.set('status',       params.status);
    if (params?.departmentId) p = p.set('departmentId', params.departmentId);
    return this.http.get<any>(this.base, { params: p });
  }

  getOne(id: string) {
    return this.http.get<any>(`${this.base}/${id}`);
  }

  create(data: any) {
    return this.http.post<any>(this.base, data);
  }

  update(id: string, data: any) {
    return this.http.put<any>(`${this.base}/${id}`, data);
  }

  remove(id: string) {
    return this.http.delete<any>(`${this.base}/${id}`);
  }

  listDepartments() {
    return this.http.get<any>(`${environment.apiUrl}/departments`);
  }

  getPayrolls(employeeId: string) {
    return this.http.get<any>(`${environment.apiUrl}/payroll/details?employeeId=${employeeId}`);
  }

  getLaborObligations(employeeId: string) {
    return this.http.get<any>(`${this.base}/${employeeId}/labor-obligations`);
  }

  updateLaborObligations(employeeId: string, data: any) {
    return this.http.put<any>(`${this.base}/${employeeId}/labor-obligations`, data);
  }

  listAllObligations(params?: { page?: number; limit?: number; search?: string }) {
    let p = new HttpParams();
    if (params?.page)   p = p.set('page',   params.page);
    if (params?.limit)  p = p.set('limit',  params.limit);
    if (params?.search) p = p.set('search', params.search);
    return this.http.get<any>(`${environment.apiUrl}/labor-obligations`, { params: p });
  }

  // ── Obligation Catalog ────────────────────────────────────────────────

  getObligationCatalog() {
    return this.http.get<any>(`${environment.apiUrl}/obligation-catalog`);
  }

  createObligationCatalogItem(data: Partial<ObligationCatalogItem>) {
    return this.http.post<any>(`${environment.apiUrl}/obligation-catalog`, data);
  }

  updateObligationCatalogItem(id: string, data: Partial<ObligationCatalogItem>) {
    return this.http.put<any>(`${environment.apiUrl}/obligation-catalog/${id}`, data);
  }

  deactivateObligationCatalogItem(id: string) {
    return this.http.delete<any>(`${environment.apiUrl}/obligation-catalog/${id}`);
  }

  updateEmployeeObligations(employeeId: string, obligations: ObligationUpsertItem[]) {
    return this.http.put<any>(`${this.base}/${employeeId}/labor-obligations`, { obligations });
  }

  getObligationPaymentRecords(params?: { employeeId?: string; page?: number; limit?: number }) {
    let p = new HttpParams();
    if (params?.employeeId) p = p.set('employeeId', params.employeeId);
    if (params?.page)       p = p.set('page',       String(params.page));
    if (params?.limit)      p = p.set('limit',      String(params.limit));
    return this.http.get<any>(`${environment.apiUrl}/labor-obligations/payment-records`, { params: p });
  }
}
