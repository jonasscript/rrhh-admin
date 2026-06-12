import { Routes } from '@angular/router';

export const CONDOMINIUM_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./condo-dashboard/condo-dashboard.component').then(m => m.CondoDashboardComponent),
  },
  {
    path: 'owners',
    loadComponent: () => import('./condo-owners/condo-owners.component').then(m => m.CondoOwnersComponent),
  },
  {
    path: 'periods',
    loadComponent: () => import('./condo-periods/condo-periods.component').then(m => m.CondoPeriodsComponent),
  },
  {
    path: 'periods/:id',
    loadComponent: () => import('./condo-period-detail/condo-period-detail.component').then(m => m.CondoPeriodDetailComponent),
  },
  {
    path: 'morosidad',
    loadComponent: () => import('./condo-morosidad/condo-morosidad.component').then(m => m.CondoMorosidadComponent),
  },
  {
    path: 'config',
    loadComponent: () => import('./condo-config/condo-config.component').then(m => m.CondoConfigComponent),
  },
];
