import { Component, OnInit, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { RouterModule }  from '@angular/router';
import { TableModule }   from 'primeng/table';
import { ButtonModule }  from 'primeng/button';
import { TagModule }     from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MessageModule } from 'primeng/message';
import { PayrollService } from '../../../shared/models/payroll.service';

const MONTHS_ES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

@Component({
  selector: 'app-payroll-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './payroll-list.component.css',
  imports: [CommonModule, RouterModule, TableModule, ButtonModule, TagModule, TooltipModule, MessageModule],
  templateUrl: './payroll-list.component.html',
})
export class PayrollListComponent implements OnInit {
  periods  = signal<any[]>([]);
  loading  = signal(false);
  creating = signal(false);

  readonly now         = new Date();
  readonly currentMonth = this.now.getMonth() + 1;
  readonly currentYear  = this.now.getFullYear();
  readonly currentMonthLabel = `${MONTHS_ES[this.currentMonth]} ${this.currentYear}`;

  /** Período del mes actual si ya fue creado */
  currentPeriod = computed(() =>
    this.periods().find(p => p.month === this.currentMonth && p.year === this.currentYear) ?? null
  );

  /** Primer período abierto (no CLOSED) */
  openPeriod = computed(() =>
    this.periods().find(p => p.status !== 'CLOSED') ?? null
  );

  /** Se puede crear si: no existe período del mes actual Y no hay ningún período abierto */
  canCreate = computed(() =>
    !this.currentPeriod() && !this.openPeriod()
  );

  /** Mensaje explicativo cuando no se puede crear */
  createBlockReason = computed((): string | null => {
    if (this.currentPeriod()) {
      return `El período de ${this.currentMonthLabel} ya fue creado.`;
    }
    const open = this.openPeriod();
    if (open) {
      return `Debe cerrar el período de ${MONTHS_ES[open.month]} ${open.year} antes de crear uno nuevo.`;
    }
    return null;
  });

  monthLabel = (m: number) => MONTHS_ES[m] ?? m;

  constructor(private svc: PayrollService) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.svc.listPeriods().subscribe({
      next: (r) => { this.periods.set(r.data); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  createPeriod() {
    this.creating.set(true);
    this.svc.createPeriod({ month: this.currentMonth, year: this.currentYear }).subscribe({
      next: () => { this.load(); this.creating.set(false); },
      error: () => this.creating.set(false),
    });
  }
}
