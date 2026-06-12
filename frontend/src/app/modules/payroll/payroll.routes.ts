import { Routes } from '@angular/router';

export const PAYROLL_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./payroll-list/payroll-list.component').then(m => m.PayrollListComponent),
  },
  {
    path: ':id',
    loadComponent: () => import('./payroll-detail/payroll-detail.component').then(m => m.PayrollDetailComponent),
  },
];
