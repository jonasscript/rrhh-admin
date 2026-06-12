import { Routes } from '@angular/router';

export const ANNOUNCEMENT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./announcement-list/announcement-list.component').then(m => m.AnnouncementListComponent),
  },
  {
    path: 'new',
    loadComponent: () => import('./announcement-form/announcement-form.component').then(m => m.AnnouncementFormComponent),
  },
];
