import { Routes } from '@angular/router';

export const SHIFT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./shift-calendar/shift-calendar.component').then(m => m.ShiftCalendarComponent),
  },
];
