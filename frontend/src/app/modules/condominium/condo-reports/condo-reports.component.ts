import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { DropdownModule } from 'primeng/dropdown';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { BalanceReport, BalancePeriodRow, CondoOwner } from '../../../shared/models/models';

@Component({
  selector: 'app-condo-reports',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, CardModule, ButtonModule,
    DropdownModule, InputNumberModule, ToastModule, TooltipModule,
    TagModule,
  ],
  providers: [MessageService],
  templateUrl: './condo-reports.component.html',
  styleUrl: './condo-reports.component.css',
})
export class CondoReportsComponent implements OnInit {
  private svc = inject(CondominiumService);
  private msg = inject(MessageService);

  report: BalanceReport | null = null;
  morosos: CondoOwner[] = [];
  loading        = false;
  downloadingPdf = false;

  yearOptions: { label: string; value: number }[] = [];
  filterYear     = new Date().getFullYear();
  filterMonthFrom: number | null = null;
  filterMonthTo:   number | null = null;

  monthOptions = [
    { label: 'Enero',      value: 1  },
    { label: 'Febrero',    value: 2  },
    { label: 'Marzo',      value: 3  },
    { label: 'Abril',      value: 4  },
    { label: 'Mayo',       value: 5  },
    { label: 'Junio',      value: 6  },
    { label: 'Julio',      value: 7  },
    { label: 'Agosto',     value: 8  },
    { label: 'Septiembre', value: 9  },
    { label: 'Octubre',    value: 10 },
    { label: 'Noviembre',  value: 11 },
    { label: 'Diciembre',  value: 12 },
  ];

  expandedRows: Record<string, boolean> = {};

  ngOnInit() {
    const cur = new Date().getFullYear();
    this.yearOptions = Array.from({ length: 5 }, (_, i) => ({ label: String(cur - i), value: cur - i }));
    this.loadReport();
  }

  loadReport() {
    this.loading = true;
    this.report  = null;
    this.morosos = [];
    const filters: Record<string, any> = { year: this.filterYear };
    if (this.filterMonthFrom) filters['month_from'] = this.filterMonthFrom;
    if (this.filterMonthTo)   filters['month_to']   = this.filterMonthTo;

    forkJoin({
      report: this.svc.getBalanceReport(filters),
      morosos: this.svc.getMorosidadReport().pipe(catchError(() => of([] as CondoOwner[]))),
    }).subscribe({
      next:  ({ report, morosos }) => {
        this.report = report;
        this.morosos = morosos;
        this.loading = false;
      },
      error: ()  => {
        this.msg.add({ severity: 'error', summary: 'Error al cargar reporte financiero' });
        this.loading = false;
      },
    });
  }

  downloadPdf() {
    this.downloadingPdf = true;
    const filters: Record<string, any> = { year: this.filterYear };
    if (this.filterMonthFrom) filters['month_from'] = this.filterMonthFrom;
    if (this.filterMonthTo)   filters['month_to']   = this.filterMonthTo;

    this.svc.downloadBalancePdf(filters).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href    = url;
        a.download = `balance_${this.filterYear}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
        this.downloadingPdf = false;
      },
      error: () => {
        this.msg.add({ severity: 'error', summary: 'Error al generar PDF' });
        this.downloadingPdf = false;
      },
    });
  }

  toggleRow(row: BalancePeriodRow) {
    const key = row.period.id;
    this.expandedRows = this.expandedRows[key] ? {} : { [key]: true };
  }

  isExpanded(row: BalancePeriodRow): boolean {
    return !!this.expandedRows[row.period.id];
  }

  monthLabel(m: number): string {
    return this.monthOptions[m - 1]?.label ?? String(m);
  }

  pctCollected(row: BalancePeriodRow): number {
    if (!row.ingresos.total_billed || row.ingresos.total_billed === 0) return 0;
    return Math.round((row.ingresos.total_collected / row.ingresos.total_billed) * 100);
  }

  get selectedPendingTotal(): number {
    return this.report?.rows.reduce((sum, row) => sum + this.periodReceivable(row), 0) ?? 0;
  }

  get totalMora(): number {
    return this.morosos.reduce((sum, owner) => sum + this.toNumber(owner.moraAmount), 0);
  }

  get delinquentOwnersCount(): number {
    return this.morosos.length;
  }

  get totalDebtPeriods(): number {
    return this.morosos.reduce((sum, owner) => sum + (owner.debtPeriods?.length || 0), 0);
  }

  get collectionRate(): number {
    const totalBilled = this.report?.summary.total_billed || 0;
    if (totalBilled <= 0) return 0;
    return Math.round(((this.report?.summary.total_collected || 0) / totalBilled) * 100);
  }

  get expenseCoverageRate(): number {
    const collected = this.report?.summary.total_collected || 0;
    if (collected <= 0) return 0;
    return Math.round((this.totalOperatingExpenses / collected) * 100);
  }

  get totalOperatingExpenses(): number {
    return this.report?.summary.total_expenses || 0;
  }

  get totalProvisionedSavings(): number {
    return this.report?.summary.total_provisions || 0;
  }

  get operatingNetResult(): number {
    if (!this.report) return 0;
    return this.round2(this.report.summary.total_collected - this.totalOperatingExpenses);
  }

  get accrualResult(): number {
    if (!this.report) return 0;
    return this.round2(this.report.summary.total_billed - this.totalOperatingExpenses);
  }

  get sortedMorosos(): CondoOwner[] {
    return [...this.morosos]
      .sort((a, b) => this.toNumber(b.moraAmount) - this.toNumber(a.moraAmount));
  }

  periodReceivable(row: BalancePeriodRow): number {
    return this.round2(Math.max(0, row.ingresos.total_billed - row.ingresos.total_collected));
  }

  periodCashResult(row: BalancePeriodRow): number {
    return this.round2(row.ingresos.total_collected - row.egresos.total_expenses);
  }

  periodAccrualResult(row: BalancePeriodRow): number {
    return this.round2(row.ingresos.total_billed - row.egresos.total_expenses);
  }

  periodOperatingCumulative(row: BalancePeriodRow): number {
    if (!this.report) return 0;
    let cumulative = 0;
    for (const item of this.report.rows) {
      cumulative = this.round2(cumulative + this.periodCashResult(item));
      if (item.period.id === row.period.id) return cumulative;
    }
    return cumulative;
  }

  sign(n: number): string { return n >= 0 ? '+' : ''; }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private toNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
