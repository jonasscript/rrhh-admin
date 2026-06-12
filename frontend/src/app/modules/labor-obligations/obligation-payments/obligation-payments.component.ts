import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }   from '@angular/common';
import { RouterModule }   from '@angular/router';
import { FormsModule }    from '@angular/forms';
import { TableModule }    from 'primeng/table';
import { ButtonModule }   from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule }      from 'primeng/tag';
import { TooltipModule }  from 'primeng/tooltip';
import { EmployeeService } from '../../../shared/models/employee.service';
import { ObligationPaymentRecord } from '../../../shared/models/obligation.model';

const MONTHS_ES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

@Component({
  selector: 'app-obligation-payments',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './obligation-payments.component.html',
  styleUrl:    './obligation-payments.component.css',
  imports: [
    CommonModule, RouterModule, FormsModule,
    TableModule, ButtonModule, InputTextModule, TagModule, TooltipModule,
  ],
})
export class ObligationPaymentsComponent implements OnInit {
  records   = signal<ObligationPaymentRecord[]>([]);
  total     = signal(0);
  loading   = signal(false);
  search    = '';
  page      = 1;
  pageSize  = 50;

  monthLabel = (m: number) => MONTHS_ES[m] ?? String(m);

  constructor(private svc: EmployeeService) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.svc.getObligationPaymentRecords({ page: this.page, limit: this.pageSize }).subscribe({
      next: (r) => {
        this.records.set(r.data ?? []);
        this.total.set(r.pagination?.total ?? (r.data ?? []).length);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  fractionLabel(rec: ObligationPaymentRecord): string {
    return `${rec.installment_num}/${rec.total_installments}`;
  }

  oblCodeSeverity(code: string): 'success' | 'info' | 'warning' | 'secondary' {
    if (code === 'DECIMO_TERCERO') return 'success';
    if (code === 'DECIMO_CUARTO')  return 'info';
    if (code === 'FONDO_RESERVA')  return 'warning';
    return 'secondary';
  }
}
