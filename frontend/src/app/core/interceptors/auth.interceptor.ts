import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const authService = inject(AuthService);
  const token = authService.token;
  const isAuthRequest = req.url.includes('/auth/login') || req.url.includes('/auth/refresh');

  const authReq = token && !isAuthRequest
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401 && isAuthRequest) {
        if (req.url.includes('/auth/refresh')) authService.logout();
        return throwError(() => error);
      }

      if (error.status === 401 && authService.refreshToken) {
        return authService.refreshAccessToken().pipe(
          switchMap(() => {
            const newToken = authService.token;
            const retryReq = req.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } });
            return next(retryReq);
          }),
          catchError((refreshErr) => {
            authService.logout();
            return throwError(() => refreshErr);
          })
        );
      }
      return throwError(() => error);
    })
  );
};
