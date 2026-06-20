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
import { DividerModule } from 'primeng/divider';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { BalanceReport, BalancePeriodRow } from '../../../shared/models/models';

@Component({
  selector: 'app-condo-reports',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, CardModule, ButtonModule,
    DropdownModule, InputNumberModule, ToastModule, TooltipModule,
    DividerModule, TagModule,
  ],
  providers: [MessageService],
  templateUrl: './condo-reports.component.html',
  styleUrl: './condo-reports.component.css',
})
export class CondoReportsComponent implements OnInit {
  private svc = inject(CondominiumService);
  private msg = inject(MessageService);

  report: BalanceReport | null = null;
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
    const filters: Record<string, any> = { year: this.filterYear };
    if (this.filterMonthFrom) filters['month_from'] = this.filterMonthFrom;
    if (this.filterMonthTo)   filters['month_to']   = this.filterMonthTo;

    this.svc.getBalanceReport(filters).subscribe({
      next:  (r) => { this.report = r; this.loading = false; },
      error: ()  => this.loading = false,
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

  sign(n: number): string { return n >= 0 ? '+' : ''; }

  fundsEntries(funds: Record<string, { name: string; balance: number }>): { id: string; name: string; balance: number }[] {
    return Object.entries(funds).map(([id, f]) => ({ id, ...f }));
  }

  totalFundsBalance(funds: Record<string, { name: string; balance: number }>): number {
    return Object.values(funds).reduce((s, f) => s + f.balance, 0);
  }
}
