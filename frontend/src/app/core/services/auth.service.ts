import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthResponse, LoginRequest, UserRole } from '../../shared/models/models';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly API = environment.apiUrl;
  private currentUserSubject = new BehaviorSubject<AuthResponse['user'] | null>(this.loadUser());

  currentUser$ = this.currentUserSubject.asObservable();

  constructor(private http: HttpClient, private router: Router) {}

  private loadUser(): AuthResponse['user'] | null {
    const stored = localStorage.getItem('rrhh_user');
    return stored ? JSON.parse(stored) : null;
  }

  get currentUser() { return this.currentUserSubject.value; }
  get token(): string | null { return localStorage.getItem('rrhh_token'); }
  get refreshToken(): string | null { return localStorage.getItem('rrhh_refresh'); }
  get isLoggedIn(): boolean { return !!this.token; }
  get role(): UserRole | null { return this.currentUser?.role ?? null; }

  hasRole(...roles: UserRole[]): boolean {
    return !!this.role && roles.includes(this.role);
  }

  login(credentials: LoginRequest): Observable<any> {
    return this.http.post<any>(`${this.API}/auth/login`, credentials).pipe(
      tap((res) => {
        localStorage.setItem('rrhh_token', res.data.token);
        localStorage.setItem('rrhh_refresh', res.data.refreshToken);
        localStorage.setItem('rrhh_user', JSON.stringify(res.data.user));
        this.currentUserSubject.next(res.data.user);
      })
    );
  }

  refreshAccessToken(): Observable<any> {
    return this.http.post<any>(`${this.API}/auth/refresh`, { refreshToken: this.refreshToken }).pipe(
      tap((res) => {
        localStorage.setItem('rrhh_token', res.data.token);
        localStorage.setItem('rrhh_refresh', res.data.refreshToken);
      })
    );
  }

  logout(): void {
    localStorage.removeItem('rrhh_token');
    localStorage.removeItem('rrhh_refresh');
    localStorage.removeItem('rrhh_user');
    this.currentUserSubject.next(null);
    this.router.navigate(['/auth/login']);
  }
}
