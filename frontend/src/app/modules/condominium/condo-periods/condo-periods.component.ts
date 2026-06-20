import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { forkJoin } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { DropdownModule } from 'primeng/dropdown';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { DividerModule } from 'primeng/divider';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoExpensePeriod, ExpenseCategory, ExpenseType, ProvisionCatalogItem } from '../../../shared/models/models';

interface PeriodLineItem {
  expenseItemId: string | null;
  name: string;
  category: ExpenseCategory;
  expenseType: ExpenseType;
  amount: number;
  selected: boolean;
  isRecurring: boolean;
  isAdHoc: boolean;
}

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;

@Component({
  selector: 'app-condo-periods',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterModule,
    TableModule, ButtonModule, DialogModule, ConfirmDialogModule,
    InputNumberModule, InputTextModule, DropdownModule,
    SelectButtonModule, CheckboxModule, TagModule,
    ToastModule, TooltipModule, SkeletonModule, DividerModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './condo-periods.component.html',
  styleUrl: './condo-periods.component.css',
})
export class CondoPeriodsComponent implements OnInit {
  private svc     = inject(CondominiumService);
  private msg     = inject(MessageService);
  private confirm = inject(ConfirmationService);
  private router  = inject(Router);

  periods: CondoExpensePeriod[] = [];
  loading   = false;
  saving    = false;
  deleting  = false;
  showDialog = false;

  // ── Dialog state ──────────────────────────────────────────
  selectedMonth = new Date().getMonth() + 1;
  selectedYear  = new Date().getFullYear();
  lineItems: PeriodLineItem[]  = [];
  adHocItems: PeriodLineItem[] = [];
  loadingItems = false;
  periodNotes  = '';

  // Provision selection (from catalog, toggled per-period)
  provisionCatalog: ProvisionCatalogItem[] = [];
  provisionItems: (ProvisionCatalogItem & { selected: boolean; customValue: number })[] = [];

  get provisionBreakdown(): { id: string; name: string; amount: number }[] {
    return this.provisionItems
      .filter(p => p.selected)
      .map(p => {
        const ct = p.calc_type as string;
        let amount: number;
        if (ct === 'FIXED')    { amount = p.value; }
        else if (ct === 'VARIABLE') { amount = p.customValue; }
        else { amount = Math.round(this.grandTotal * p.value / 100 * 100) / 100; }
        return { id: p.id, name: p.name, amount };
      });
  }
  get totalProvisions():          number { return this.provisionBreakdown.reduce((s, p) => s + p.amount, 0); }
  get grandTotalWithProvisions(): number { return this.grandTotal + this.totalProvisions; }

  monthOptions = MONTHS.map((label, i) => ({ label, value: i + 1 }));
  typeOptions  = [
    { label: 'Fijo',     value: 'FIXED'    as ExpenseType },
    { label: 'Variable', value: 'VARIABLE' as ExpenseType },
  ];

  // ── Computed totals ───────────────────────────────────────
  get fixedTotal(): number {
    return [...this.lineItems, ...this.adHocItems]
      .filter(i => i.selected && i.expenseType === 'FIXED')
      .reduce((s, i) => s + (i.amount || 0), 0);
  }
  get variableTotal(): number {
    return [...this.lineItems, ...this.adHocItems]
      .filter(i => i.selected && i.expenseType === 'VARIABLE')
      .reduce((s, i) => s + (i.amount || 0), 0);
  }
  get grandTotal(): number { return this.fixedTotal + this.variableTotal; }

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    this.svc.getPeriods().subscribe({
      next:  (p) => { this.periods = p; this.loading = false; },
      error: () => this.loading = false,
    });
  }

  openNewPeriod() {
    this.selectedMonth = new Date().getMonth() + 1;
    this.selectedYear  = new Date().getFullYear();
    this.adHocItems    = [];
    this.lineItems     = [];
    this.periodNotes   = '';
    this.loadingItems  = true;
    this.showDialog    = true;

    forkJoin({
      items:     this.svc.getExpenseItems(),
      config:    this.svc.getConfig(),
      catalog:   this.svc.getProvisionCatalog(),
    }).subscribe({
      next: ({ items, config, catalog }) => {
        this.provisionCatalog = catalog;
        this.provisionItems   = catalog.map(p => ({
          ...p,
          value:       parseFloat(String(p.value)) || 0,
          customValue: parseFloat(String(p.value)) || 0,
          selected:    p.is_active,
        }));
        this.lineItems = items.items
          .filter(i => i.isActive)
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map(i => ({
            expenseItemId: i.id,
            name:          i.name,
            category:      i.category,
            expenseType:   i.expenseType,
            amount:        i.amount,
            selected:      i.isRecurring,
            isRecurring:   i.isRecurring,
            isAdHoc:       false,
          }));
        this.loadingItems = false;
      },
      error: () => { this.lineItems = []; this.loadingItems = false; },
    });
  }

  addAdHoc() {
    this.adHocItems.push({
      expenseItemId: null, name: '', category: 'OTHER',
      expenseType: 'VARIABLE', amount: 0,
      selected: true, isRecurring: false, isAdHoc: true,
    });
  }

  removeAdHoc(i: number) { this.adHocItems.splice(i, 1); }

  create() {
    if (this.grandTotal === 0) return;
    this.saving = true;

    const items = [
      ...this.lineItems.filter(i => i.selected),
      ...this.adHocItems.filter(i => i.amount > 0 && i.name.trim()),
    ].map(i => ({
      expenseItemId: i.expenseItemId,
      name:          i.name || 'Gasto',
      category:      i.category,
      expenseType:   i.expenseType,
      amount:        i.amount,
    }));

    const selectedProvisions = this.provisionItems.filter(p => p.selected);
    const provisionAmounts: Record<string, number> = {};
    for (const p of selectedProvisions) {
      if ((p.calc_type as string) === 'VARIABLE') provisionAmounts[p.id] = p.customValue;
    }
    this.svc.createPeriod({
      month: this.selectedMonth, year: this.selectedYear,
      items,
      notes:            this.periodNotes || undefined,
      provisionIds:     selectedProvisions.map(p => p.id),
      provisionAmounts: Object.keys(provisionAmounts).length ? provisionAmounts : undefined,
    }).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Período creado' });
        this.showDialog = false; this.saving = false; this.load();
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.saving = false;
      },
    });
  }

  // ── Helpers ───────────────────────────────────────────────
  monthName(m: number) { return MONTHS[m - 1]; }

  severity(s: string): TagSeverity {
    return s === 'CLOSED' ? 'danger' : s === 'APPROVED' ? 'success' : 'info';
  }

  fixedSum(p: any): number {
    return ((p.fixed_maintenance || 0) + (p.fixed_security || 0) +
            (p.fixed_cleaning    || 0) + (p.fixed_other    || 0));
  }

  effectiveTotal(p: any): number {
    return parseFloat(p.grand_total) > 0 ? parseFloat(p.grand_total) : parseFloat(p.total_expenses) || 0;
  }

  goToExpenses() { this.router.navigate(['/condominium/expenses']); }

  confirmDelete(p: CondoExpensePeriod) {
    this.confirm.confirm({
      header: 'Eliminar período',
      message: `¿Eliminar <strong>${this.monthName(p.month)} ${p.year}</strong>? Se borrarán todas las alícuotas, pagos y movimientos de fondos asociados. Esta acción no se puede deshacer.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.deletePeriod(p),
    });
  }

  private deletePeriod(p: CondoExpensePeriod) {
    this.deleting = true;
    this.svc.deletePeriod(p.id).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Período eliminado', detail: `${this.monthName(p.month)} ${p.year}` });
        this.deleting = false;
        this.load();
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.deleting = false;
      },
    });
  }
}
