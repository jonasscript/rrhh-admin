import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoExpensePeriod, CondoOwner } from '../../../shared/models/models';

type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;

interface DashboardMetric {
  label: string;
  value: string;
  hint: string;
  icon: string;
  tone: 'blue' | 'green' | 'amber' | 'red' | 'slate';
}

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

@Component({
  selector: 'app-condo-dashboard',
  standalone: true,
  imports: [CommonModule, CardModule, TagModule],
  templateUrl: './condo-dashboard.component.html',
  styleUrl: './condo-dashboard.component.css',
})
export class CondoDashboardComponent implements OnInit {
  private svc = inject(CondominiumService);

  loading = false;
  hasError = false;

  owners: CondoOwner[] = [];
  morosos: CondoOwner[] = [];
  periods: CondoExpensePeriod[] = [];

  ngOnInit() {
    this.loadDashboard();
  }

  loadDashboard() {
    this.loading = true;
    this.hasError = false;

    forkJoin({
      owners: this.svc.getOwners(false).pipe(catchError(() => of({ owners: [], totalParticipationPct: 0 }))),
      morosos: this.svc.getMorosidadReport().pipe(catchError(() => of([] as CondoOwner[]))),
      periods: this.svc.getPeriods().pipe(catchError(() => of([] as CondoExpensePeriod[]))),
    }).subscribe({
      next: ({ owners, morosos, periods }) => {
        this.owners = owners.owners;
        this.morosos = morosos;
        this.periods = periods;
        this.loading = false;
      },
      error: () => {
        this.hasError = true;
        this.loading = false;
      },
    });
  }

  get activeOwners(): CondoOwner[] {
    return this.owners.filter(o => o.isActive);
  }

  get inactiveOwnersCount(): number {
    return this.owners.length - this.activeOwners.length;
  }

  get totalMora(): number {
    return this.morosos.reduce((sum, owner) => sum + this.toNumber(owner.moraAmount), 0);
  }

  get latestPeriod(): CondoExpensePeriod | null {
    return [...this.periods]
      .sort((a, b) => (b.year - a.year) || (b.month - a.month))
      [0] ?? null;
  }

  get openPeriodsCount(): number {
    return this.periods.filter(p => p.status !== 'CLOSED').length;
  }

  get latestCollectionPct(): number {
    if (this.latestBilled <= 0) return 0;
    return Math.min(100, Math.round((this.latestCollected / this.latestBilled) * 100));
  }

  get latestBilled(): number {
    const period = this.latestPeriod;
    return period ? this.toNumber(period.grand_total || period.total_expenses) : 0;
  }

  get latestCollected(): number {
    return this.toNumber(this.latestPeriod?.total_collected);
  }

  get latestPending(): number {
    return Math.max(this.latestBilled - this.latestCollected, 0);
  }

  get paidPaymentsLabel(): string {
    const period = this.latestPeriod;
    if (!period) return '0 / 0';
    return `${period.paid_count || 0} / ${period.total_payments || this.activeOwners.length}`;
  }

  get statusTitle(): string {
    if (!this.latestPeriod) return 'Sin períodos de cobro';
    if (this.latestCollectionPct < 60 || this.totalMora > 0) return 'Requiere atención';
    if (this.latestCollectionPct < 90 || this.openPeriodsCount > 0) return 'En seguimiento';
    return 'Operación al día';
  }

  get statusHint(): string {
    if (!this.latestPeriod) return 'Crea el primer período para empezar a medir cobranza y obligaciones.';
    if (this.totalMora > 0) return `${this.morosos.length} copropietarios mantienen saldos pendientes.`;
    if (this.openPeriodsCount > 0) return 'Hay períodos abiertos que conviene revisar o cerrar.';
    return 'La recaudación del último período se mantiene en buen estado.';
  }

  get statusSeverity(): TagSeverity {
    return this.statusTitle === 'Operación al día' ? 'success' :
           this.statusTitle === 'Sin períodos de cobro' ? 'secondary' :
           this.statusTitle === 'En seguimiento' ? 'warning' : 'danger';
  }

  get metrics(): DashboardMetric[] {
    return [
      {
        label: 'Copropietarios activos',
        value: String(this.activeOwners.length),
        hint: `${this.owners.length} registrados · ${this.inactiveOwnersCount} inactivos`,
        icon: 'pi pi-users',
        tone: 'blue',
      },
      {
        label: 'Morosidad acumulada',
        value: this.currency(this.totalMora),
        hint: `${this.morosos.length} copropietarios con saldo pendiente`,
        icon: 'pi pi-exclamation-triangle',
        tone: this.totalMora > 0 ? 'red' : 'green',
      },
      {
        label: 'Recaudación',
        value: `${this.latestCollectionPct}%`,
        hint: this.latestPeriod ? this.periodLabel(this.latestPeriod) : 'Sin períodos generados',
        icon: 'pi pi-chart-line',
        tone: this.latestCollectionPct >= 90 ? 'green' : this.latestCollectionPct >= 60 ? 'amber' : 'red',
      },
      {
        label: 'Períodos abiertos',
        value: String(this.openPeriodsCount),
        hint: `${this.periods.length} períodos registrados`,
        icon: 'pi pi-calendar-clock',
        tone: this.openPeriodsCount > 0 ? 'amber' : 'green',
      },
    ];
  }

  metricValue(metric: DashboardMetric): string {
    return metric.value;
  }

  periodLabel(period: CondoExpensePeriod | null): string {
    if (!period) return 'Sin período';
    return `${MONTHS[period.month - 1] ?? period.month} ${period.year}`;
  }

  periodStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      DRAFT: 'Borrador',
      GENERATED: 'Generado',
      APPROVED: 'Aprobado',
      CLOSED: 'Cerrado',
    };
    return labels[status] ?? status;
  }

  periodStatusSeverity(status: string): TagSeverity {
    return status === 'CLOSED' ? 'success' :
           status === 'APPROVED' ? 'info' :
           status === 'GENERATED' ? 'warning' : 'secondary';
  }

  collectionSeverity(pct: number): TagSeverity {
    return pct >= 90 ? 'success' : pct >= 60 ? 'warning' : 'danger';
  }

  currency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(this.toNumber(value));
  }

  private toNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
