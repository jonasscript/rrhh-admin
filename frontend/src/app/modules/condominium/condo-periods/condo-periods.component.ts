import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoExpensePeriod } from '../../../shared/models/models';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;

@Component({
  selector: 'app-condo-periods',
  standalone: true,
  imports: [CommonModule, RouterModule, ReactiveFormsModule, TableModule, ButtonModule, DialogModule, InputNumberModule, InputTextModule, InputTextareaModule, TagModule, ToastModule],
  providers: [MessageService],
  templateUrl: './condo-periods.component.html',
  styleUrl: './condo-periods.component.css',
})
export class CondoPeriodsComponent implements OnInit {
  private svc = inject(CondominiumService);
  private fb = inject(FormBuilder);
  private msg = inject(MessageService);

  periods: CondoExpensePeriod[] = [];
  loading = false; saving = false; showDialog = false;

  form = this.fb.group({
    month: [new Date().getMonth() + 1, [Validators.required, Validators.min(1), Validators.max(12)]],
    year: [new Date().getFullYear(), Validators.required],
    variableExpenses: [0],
    variableNotes: [''],
  });

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    this.svc.getPeriods().subscribe({ next: (p) => { this.periods = p; this.loading = false; }, error: () => this.loading = false });
  }

  create() {
    if (this.form.invalid) return;
    this.saving = true;
    this.svc.createPeriod(this.form.value as any).subscribe({
      next: () => { this.msg.add({ severity: 'success', summary: 'Período creado', detail: '' }); this.showDialog = false; this.saving = false; this.load(); },
      error: (err) => { this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }); this.saving = false; },
    });
  }

  monthName(m: number) { return MONTHS[m - 1]; }
  severity(s: string): TagSeverity { return s === 'CLOSED' ? 'danger' : s === 'APPROVED' ? 'success' : 'info'; }
}
