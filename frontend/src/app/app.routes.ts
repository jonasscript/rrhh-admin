import { Routes } from '@angular/router';
import { authGuard, roleGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'auth',
    loadChildren: () => import('./modules/auth/auth.routes').then(m => m.AUTH_ROUTES),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/app-layout.component').then(m => m.AppLayoutComponent),
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        loadComponent: () => import('./modules/dashboard/dashboard.component').then(m => m.DashboardComponent),
      },
      {
        path: 'employees',
        loadChildren: () => import('./modules/employees/employees.routes').then(m => m.EMPLOYEE_ROUTES),
      },
      {
        path: 'payroll',
        canActivate: [roleGuard('ADMIN', 'HR')],
        loadChildren: () => import('./modules/payroll/payroll.routes').then(m => m.PAYROLL_ROUTES),
      },
      {
        path: 'labor-obligations',
        canActivate: [roleGuard('ADMIN', 'HR')],
        loadChildren: () => import('./modules/labor-obligations/labor-obligations.routes').then(m => m.LABOR_OBLIGATION_ROUTES),
      },
      {
        path: 'vacations',
        loadChildren: () => import('./modules/vacations/vacations.routes').then(m => m.VACATION_ROUTES),
      },
      {
        path: 'shifts',
        loadChildren: () => import('./modules/shifts/shifts.routes').then(m => m.SHIFT_ROUTES),
      },
      {
        path: 'announcements',
        loadChildren: () => import('./modules/announcements/announcements.routes').then(m => m.ANNOUNCEMENT_ROUTES),
      },
      {
        path: 'condominium',
        canActivate: [roleGuard('ADMIN', 'HR')],
        loadChildren: () => import('./modules/condominium/condominium.routes').then(m => m.CONDOMINIUM_ROUTES),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
