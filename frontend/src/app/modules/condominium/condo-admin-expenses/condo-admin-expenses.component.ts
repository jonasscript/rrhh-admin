import { CommonModule } from '@angular/common';
import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { DropdownModule } from 'primeng/dropdown';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmationService, MessageService } from 'primeng/api';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { CondominiumService } from '../../../shared/models/condominium.service';
import {
  CondoAdminExpense,
  CondoAdminExpenseCategory,
  CondoAdminExpenseListResponse,
  CondoAdminExpenseType,
  CondoAdminPaymentMethod,
} from '../../../shared/models/models';

type Severity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;

const TYPE_LABELS: Record<CondoAdminExpenseType, string> = {
  ADMINISTRATIVE: 'Administrativo',
  BUILDING_SERVICE: 'Servicio del edificio',
  MAINTENANCE: 'Mantenimiento eventual',
  OTHER: 'Otro',
};

const CATEGORY_LABELS: Record<CondoAdminExpenseCategory, string> = {
  MAINTENANCE: 'Mantenimiento',
  SECURITY: 'Seguridad',
  CLEANING: 'Limpieza',
  UTILITIES: 'Servicios',
  ADMINISTRATION: 'Administración',
  REPAIR: 'Reparación',
  SUPPLIES: 'Suministros',
  OTHER: 'Otros',
};

const PAYMENT_LABELS: Record<CondoAdminPaymentMethod, string> = {
  CASH: 'Efectivo',
  TRANSFER: 'Transferencia',
  CARD: 'Tarjeta',
  CHECK: 'Cheque',
  OTHER: 'Otro',
};

@Component({
  selector: 'app-condo-admin-expenses',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule, ButtonModule, ConfirmDialogModule,
    DialogModule, DropdownModule, InputNumberModule, InputTextModule, InputTextareaModule,
    TableModule, TagModule, ToastModule, TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './condo-admin-expenses.component.html',
  styleUrl: './condo-admin-expenses.component.css',
})
export class CondoAdminExpensesComponent implements OnInit {
  private svc = inject(CondominiumService);
  private fb = inject(FormBuilder);
  private msg = inject(MessageService);
  private confirm = inject(ConfirmationService);
  private sanitizer = inject(DomSanitizer);

  data: CondoAdminExpenseListResponse = { items: [], total: 0 };
  loading = false;
  saving = false;
  showWizard = false;
  showReceiptPreview = false;
  currentStep = 0;
  selectedReceipt: File | null = null;
  receiptPreviewItem: CondoAdminExpense | null = null;
  receiptPreviewUrl: SafeResourceUrl | null = null;
  editing: CondoAdminExpense | null = null;
  filterDateFrom = '';
  filterDateTo = '';

  typeOptions = Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }));
  categoryOptions = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));
  paymentOptions = Object.entries(PAYMENT_LABELS).map(([value, label]) => ({ value, label }));

  form = this.fb.group({
    expenseDate: [new Date().toISOString().slice(0, 10), Validators.required],
    expenseType: ['ADMINISTRATIVE' as CondoAdminExpenseType, Validators.required],
    category: ['ADMINISTRATION' as CondoAdminExpenseCategory, Validators.required],
    vendor: ['', [Validators.required, Validators.minLength(2)]],
    description: ['', [Validators.required, Validators.minLength(3)]],
    amount: [0, [Validators.required, Validators.min(0.01)]],
    paymentMethod: ['TRANSFER' as CondoAdminPaymentMethod, Validators.required],
    notes: [''],
  });

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading = true;
    this.svc.getAdminExpenses({
      date_from: this.filterDateFrom || undefined,
      date_to: this.filterDateTo || undefined,
      limit: 200,
    }).subscribe({
      next: (data) => { this.data = data; this.loading = false; },
      error: () => {
        this.loading = false;
        this.msg.add({ severity: 'error', summary: 'No se pudieron cargar los gastos' });
      },
    });
  }

  nextStep() {
    if (this.currentStep === 0 && this.stepOneInvalid) return;
    if (this.currentStep === 1 && this.stepTwoInvalid) return;
    this.currentStep = Math.min(2, this.currentStep + 1);
  }

  prevStep() {
    this.currentStep = Math.max(0, this.currentStep - 1);
  }

  startNew() {
    this.resetForm();
    this.showWizard = true;
  }

  private resetForm() {
    this.editing = null;
    this.currentStep = 0;
    this.selectedReceipt = null;
    this.form.reset({
      expenseDate: new Date().toISOString().slice(0, 10),
      expenseType: 'ADMINISTRATIVE',
      category: 'ADMINISTRATION',
      vendor: '',
      description: '',
      amount: 0,
      paymentMethod: 'TRANSFER',
      notes: '',
    });
  }

  edit(item: CondoAdminExpense) {
    this.editing = item;
    this.currentStep = 0;
    this.selectedReceipt = null;
    this.showWizard = true;
    this.form.patchValue({
      expenseDate: String(item.expenseDate).slice(0, 10),
      expenseType: item.expenseType,
      category: item.category,
      vendor: item.vendor,
      description: item.description,
      amount: item.amount,
      paymentMethod: item.paymentMethod,
      notes: item.notes || '',
    });
  }

  onReceiptSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    this.selectedReceipt = input.files?.[0] || null;
  }

  save() {
    if (this.form.invalid || (!this.editing && !this.selectedReceipt)) {
      this.form.markAllAsTouched();
      if (!this.selectedReceipt && !this.editing) {
        this.msg.add({ severity: 'warn', summary: 'Recibo obligatorio', detail: 'Adjunta el recibo de compra para continuar.' });
      }
      return;
    }

    this.saving = true;
    const value = this.form.getRawValue();
    const payload = {
      expenseDate: value.expenseDate || new Date().toISOString().slice(0, 10),
      expenseType: value.expenseType || 'ADMINISTRATIVE',
      category: value.category || 'ADMINISTRATION',
      vendor: value.vendor || '',
      description: value.description || '',
      amount: Number(value.amount || 0),
      paymentMethod: value.paymentMethod || 'TRANSFER',
      notes: value.notes || undefined,
    };
    const request = this.editing
      ? this.svc.updateAdminExpense(this.editing.id, payload)
      : this.svc.createAdminExpense(payload, this.selectedReceipt as File);

    request.subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: this.editing ? 'Gasto actualizado' : 'Gasto registrado' });
        this.saving = false;
        this.showWizard = false;
        this.resetForm();
        this.load();
      },
      error: (err) => {
        this.saving = false;
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message || 'No se pudo guardar el gasto.' });
      },
    });
  }

  confirmDelete(item: CondoAdminExpense) {
    this.confirm.confirm({
      header: 'Eliminar gasto',
      message: `¿Eliminar el gasto de ${this.currency(item.amount)} registrado a ${item.vendor}?`,
      icon: 'pi pi-trash',
      acceptLabel: 'Eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.svc.deleteAdminExpense(item.id).subscribe({
          next: () => { this.msg.add({ severity: 'success', summary: 'Gasto eliminado' }); this.load(); },
          error: (err) => this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }),
        });
      },
    });
  }

  applyFilters() {
    this.load();
  }

  clearFilters() {
    this.filterDateFrom = '';
    this.filterDateTo = '';
    this.load();
  }

  openReceiptPreview(item: CondoAdminExpense) {
    this.receiptPreviewItem = item;
    this.receiptPreviewUrl = this.sanitizer.bypassSecurityTrustResourceUrl(item.receiptUrl);
    this.showReceiptPreview = true;
  }

  closeReceiptPreview() {
    this.showReceiptPreview = false;
    this.receiptPreviewItem = null;
    this.receiptPreviewUrl = null;
  }

  isReceiptImage(item: CondoAdminExpense | null): boolean {
    return /\.(jpe?g|png|webp|gif)($|\?)/i.test(item?.receiptUrl || '');
  }

  get stepOneInvalid(): boolean {
    return !!(this.form.controls.expenseDate.invalid || this.form.controls.expenseType.invalid || this.form.controls.category.invalid);
  }

  get stepTwoInvalid(): boolean {
    return !!(this.form.controls.vendor.invalid || this.form.controls.description.invalid || this.form.controls.amount.invalid || this.form.controls.paymentMethod.invalid);
  }

  get monthTotal(): number {
    const now = new Date();
    return this.data.items
      .filter(item => {
        const date = new Date(`${String(item.expenseDate).slice(0, 10)}T12:00:00`);
        return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
      })
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  }

  get eventualTotal(): number {
    return this.data.items
      .filter(item => item.expenseType === 'BUILDING_SERVICE' || item.expenseType === 'MAINTENANCE')
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  }

  get canSave(): boolean {
    return this.form.valid && (!!this.selectedReceipt || !!this.editing);
  }

  typeLabel(type: CondoAdminExpenseType): string { return TYPE_LABELS[type] || type; }
  categoryLabel(category: CondoAdminExpenseCategory): string { return CATEGORY_LABELS[category] || category; }
  paymentLabel(method: CondoAdminPaymentMethod): string { return PAYMENT_LABELS[method] || method; }
  typeSeverity(type: CondoAdminExpenseType): Severity {
    return type === 'ADMINISTRATIVE' ? 'info' : type === 'BUILDING_SERVICE' ? 'warning' : type === 'MAINTENANCE' ? 'success' : 'secondary';
  }
  currency(value: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
  }
}
