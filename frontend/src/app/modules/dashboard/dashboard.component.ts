import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { ChartModule } from 'primeng/chart';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, CardModule, ChartModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent {
  stats = [
    { label: 'Empleados Activos', value: '—', icon: 'pi-users', color: '#3b82f6' },
    { label: 'Nómina del Mes', value: '—', icon: 'pi-money-bill', color: '#10b981' },
    { label: 'Vacaciones Pendientes', value: '—', icon: 'pi-sun', color: '#f59e0b' },
    { label: 'Co-propietarios en Mora', value: '—', icon: 'pi-exclamation-triangle', color: '#ef4444' },
  ];
}
