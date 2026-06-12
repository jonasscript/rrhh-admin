import { Routes } from '@angular/router';

export const LABOR_OBLIGATION_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./labor-obligations-list/labor-obligations-list.component').then(
        m => m.LaborObligationsListComponent
      ),
  },
  {
    path: 'catalog',
    loadComponent: () =>
      import('./obligation-catalog/obligation-catalog.component').then(
        m => m.ObligationCatalogComponent
      ),
  },
  {
    path: 'payments',
    loadComponent: () =>
      import('./obligation-payments/obligation-payments.component').then(
        m => m.ObligationPaymentsComponent
      ),
  },
];
