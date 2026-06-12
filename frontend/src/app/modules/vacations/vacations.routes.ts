import { Routes } from '@angular/router';

export const VACATION_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./vacation-list/vacation-list.component').then(m => m.VacationListComponent),
  },
];
