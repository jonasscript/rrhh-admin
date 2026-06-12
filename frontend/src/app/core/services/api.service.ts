import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ApiService {
  protected readonly BASE = environment.apiUrl;

  constructor(protected http: HttpClient) {}

  protected get<T>(url: string, params?: Record<string, any>): Observable<T> {
    let httpParams = new HttpParams();
    if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) httpParams = httpParams.set(k, v); });
    return this.http.get<any>(`${this.BASE}${url}`, { params: httpParams }).pipe(map(r => r.data));
  }

  protected post<T>(url: string, body: any): Observable<T> {
    return this.http.post<any>(`${this.BASE}${url}`, body).pipe(map(r => r.data));
  }

  protected patch<T>(url: string, body: any): Observable<T> {
    return this.http.patch<any>(`${this.BASE}${url}`, body).pipe(map(r => r.data));
  }

  protected put<T>(url: string, body: any): Observable<T> {
    return this.http.put<any>(`${this.BASE}${url}`, body).pipe(map(r => r.data));
  }

  protected delete<T>(url: string): Observable<T> {
    return this.http.delete<any>(`${this.BASE}${url}`).pipe(map(r => r.data));
  }

  protected postFormData<T>(url: string, formData: FormData): Observable<T> {
    return this.http.post<any>(`${this.BASE}${url}`, formData).pipe(map(r => r.data));
  }
}
