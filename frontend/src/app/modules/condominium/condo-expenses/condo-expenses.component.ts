import { Component, inject, OnInit } from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DropdownModule } from 'primeng/dropdown';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoExpenseItem, CondoExpenseItemsResponse, ExpenseCategory, ExpenseType } from '../../../shared/models/models';

const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  MAINTENANCE:    'Mantenimiento',
  SECURITY:       'Seguridad',
  CLEANING:       'Limpieza',
  UTILITIES:      'Servicios',
  ADMINISTRATION: 'Administración',
  OTHER:          'Otros',
};

const CATEGORY_ICONS: Record<ExpenseCategory, string> = {
  MAINTENANCE:    'pi-wrench',
  SECURITY:       'pi-shield',
  CLEANING:       'pi-sparkles',
  UTILITIES:      'pi-bolt',
  ADMINISTRATION: 'pi-briefcase',
  OTHER:          'pi-tag',
};

type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;

@Component({
  selector: 'app-condo-expenses',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule,
    TableModule, ButtonModule, DialogModule,
    InputTextModule, InputNumberModule, InputTextareaModule,
    SelectButtonModule, DropdownModule, TagModule,
    ToastModule, TooltipModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './condo-expenses.component.html',
  styleUrl: './condo-expenses.component.css',
})
export class CondoExpensesComponent implements OnInit {
  private svc     = inject(CondominiumService);
  private fb      = inject(FormBuilder);
  private msg     = inject(MessageService);
  private confirm = inject(ConfirmationService);

  data: CondoExpenseItemsResponse = { items: [], totalFixed: 0, totalVariable: 0, total: 0 };
  loading  = false;
  saving   = false;
  showDialog = false;
  editing: CondoExpenseItem | null = null;

  categoryOptions = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));
  typeOptions = [
    { label: 'Fijo', value: 'FIXED', icon: 'pi pi-lock' },
    { label: 'Variable', value: 'VARIABLE', icon: 'pi pi-sliders-h' },
  ];

  form = this.fb.group({
    name:         ['', [Validators.required, Validators.minLength(2)]],
    description:  [''],
    category:     ['OTHER' as ExpenseCategory, Validators.required],
    expenseType:  ['FIXED' as ExpenseType, Validators.required],
    amount:       [0, [Validators.required, Validators.min(0)]],
    isRecurring:  [true],
    displayOrder: [0],
  });

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    this.svc.getExpenseItems().subscribe({
      next:  (d) => { this.data = d; this.loading = false; },
      error: () => this.loading = false,
    });
  }

  openCreate() {
    this.editing = null;
    this.form.reset({ category: 'OTHER', expenseType: 'FIXED', amount: 0, isRecurring: true, displayOrder: 0 });
    this.showDialog = true;
  }

  openEdit(item: CondoExpenseItem) {
    this.editing = item;
    this.form.patchValue({
      name: item.name, description: item.description ?? '',
      category: item.category, expenseType: item.expenseType,
      amount: item.amount, isRecurring: item.isRecurring,
      displayOrder: item.displayOrder,
    });
    this.showDialog = true;
  }

  save() {
    if (this.form.invalid) return;
    this.saving = true;
    const payload = this.form.value as Partial<CondoExpenseItem>;
    const obs = this.editing
      ? this.svc.updateExpenseItem(this.editing.id, payload)
      : this.svc.createExpenseItem(payload);

    obs.subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: this.editing ? 'Ítem actualizado' : 'Ítem creado', detail: '' });
        this.showDialog = false;
        this.saving = false;
        this.load();
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message ?? 'Error desconocido' });
        this.saving = false;
      },
    });
  }

  toggle(item: CondoExpenseItem) {
    this.svc.toggleExpenseItem(item.id).subscribe({
      next: () => this.load(),
      error: (err) => this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }),
    });
  }

  confirmDelete(item: CondoExpenseItem) {
    this.confirm.confirm({
      header:  'Eliminar ítem',
      message: `¿Eliminar "${item.name}"? Esta acción no se puede deshacer.`,
      icon:    'pi pi-trash',
      acceptLabel: 'Eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.svc.deleteExpenseItem(item.id).subscribe({
          next:  () => { this.msg.add({ severity: 'success', summary: 'Ítem eliminado', detail: '' }); this.load(); },
          error: (err) => this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }),
        });
      },
    });
  }

  categoryLabel(cat: ExpenseCategory) { return CATEGORY_LABELS[cat] ?? cat; }
  categoryIcon(cat: ExpenseCategory)  { return CATEGORY_ICONS[cat] ?? 'pi-tag'; }

  typeSeverity(t: ExpenseType): TagSeverity { return t === 'FIXED' ? 'info' : 'warning'; }
  typeLabel(t: ExpenseType) { return t === 'FIXED' ? 'Fijo' : 'Variable'; }

  get fixedItems()    { return this.data.items.filter(i => i.expenseType === 'FIXED'); }
  get variableItems() { return this.data.items.filter(i => i.expenseType === 'VARIABLE'); }
  get activeRecurringTotal() {
    return this.data.items.filter(i => i.isActive && i.isRecurring).reduce((s, i) => s + i.amount, 0);
  }
}
