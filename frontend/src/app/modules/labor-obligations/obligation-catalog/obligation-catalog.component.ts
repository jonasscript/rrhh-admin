import {
  Component, OnInit, ChangeDetectionStrategy, signal,
} from '@angular/core';
import { CommonModule }       from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { TableModule }        from 'primeng/table';
import { ButtonModule }       from 'primeng/button';
import { DialogModule }       from 'primeng/dialog';
import { TagModule }          from 'primeng/tag';
import { ToastModule }        from 'primeng/toast';
import { TooltipModule }      from 'primeng/tooltip';
import { InputTextModule }    from 'primeng/inputtext';
import { InputNumberModule }  from 'primeng/inputnumber';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CheckboxModule }     from 'primeng/checkbox';
import { CalendarModule }     from 'primeng/calendar';
import { DropdownModule }     from 'primeng/dropdown';
import { InputTextareaModule }    from 'primeng/inputtextarea';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { EmployeeService } from '../../../shared/models/employee.service';
import { ObligationCatalogItem } from '../../../shared/models/obligation.model';

@Component({
  selector: 'app-obligation-catalog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './obligation-catalog.component.html',
  styleUrl:    './obligation-catalog.component.css',
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule,
    TableModule, ButtonModule, DialogModule, TagModule,
    ToastModule, TooltipModule, InputTextModule, InputNumberModule,
    SelectButtonModule, CheckboxModule, CalendarModule, DropdownModule,
    InputTextareaModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
})
export class ObligationCatalogComponent implements OnInit {
  catalog  = signal<ObligationCatalogItem[]>([]);
  loading  = signal(false);
  saving   = signal(false);

  dialogVisible = signal(false);
  editingId     = signal<string | null>(null);

  calcTypeOptions = [
    { label: 'Porcentaje', value: 'PERCENTAGE' },
    { label: 'Valor fijo', value: 'FIXED' },
  ];
  payerOptions = [
    { label: 'Patrono', value: 'EMPLOYER' },
    { label: 'Empleado', value: 'EMPLOYEE' },
  ];
  recipientOptions = [
    { label: 'IESS', value: 'IESS' },
    { label: 'Empleado', value: 'EMPLOYEE' },
    { label: 'Otro', value: 'OTHER' },
  ];

  paymentModeOptions = [
    { label: 'Mensual (se provisiona cada mes)', value: 'MONTHLY' },
    { label: 'Fecha específica (pago único en el año)', value: 'LUMP_SUM' },
  ];

  monthOptions = [
    { label: 'Enero',      value: 1  }, { label: 'Febrero',   value: 2  },
    { label: 'Marzo',      value: 3  }, { label: 'Abril',      value: 4  },
    { label: 'Mayo',       value: 5  }, { label: 'Junio',      value: 6  },
    { label: 'Julio',      value: 7  }, { label: 'Agosto',     value: 8  },
    { label: 'Septiembre', value: 9  }, { label: 'Octubre',    value: 10 },
    { label: 'Noviembre',  value: 11 }, { label: 'Diciembre',  value: 12 },
  ];

  form = this.fb.group({
    name:             ['', [Validators.required, Validators.maxLength(100)]],
    description:      [''],
    calc_type:        ['PERCENTAGE', Validators.required],
    default_value:    [null as number | null],
    payer:            ['EMPLOYER', Validators.required],
    recipient:        ['IESS', Validators.required],
    display_order:    [99],
    payment_mode:     ['MONTHLY' as 'MONTHLY' | 'LUMP_SUM'],
    has_payment_date: [false],   // UI only — controla si se muestra el calendario
    payment_date:     [null as Date | null], // UI only — se extrae month+day al guardar
  });

  constructor(
    private svc: EmployeeService,
    private fb: FormBuilder,
    private msg: MessageService,
    private confirm: ConfirmationService,
  ) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.svc.getObligationCatalog().subscribe({
      next: (r) => { this.catalog.set(r.data); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  openCreate() {
    this.editingId.set(null);
    this.form.reset({
      name: '', description: '', calc_type: 'PERCENTAGE',
      default_value: null, payer: 'EMPLOYER', recipient: 'IESS', display_order: 99,
      payment_mode: 'MONTHLY', has_payment_date: false, payment_date: null,
    });
    this._enableAllSystemFields();
    this.dialogVisible.set(true);
  }

  openEdit(item: ObligationCatalogItem) {
    this.editingId.set(item.id);
    this.form.patchValue({
      name:          item.name,
      description:   item.description ?? '',
      calc_type:     item.calc_type,
      // Percentages are stored as decimals (0.0833) but displayed as whole numbers (8.33%)
      default_value: item.default_value != null
        ? (item.calc_type === 'PERCENTAGE'
            ? Math.round(parseFloat(String(item.default_value)) * 10000) / 100  // 0.0833 → 8.33
            : parseFloat(String(item.default_value)))
        : null,
      payer:         item.payer,
      recipient:     item.recipient,
      display_order: item.display_order,
      payment_mode:  (item as any).payment_mode ?? 'MONTHLY',
      has_payment_date: !!(item.payment_month || item.payment_day),
      payment_date:  this._buildPaymentDate(item.payment_month, item.payment_day),
    });
    // Block structural fields for system items
    if (item.is_system) {
      this.form.get('calc_type')?.disable();
      this.form.get('payer')?.disable();
      this.form.get('recipient')?.disable();
      this.form.get('default_value')?.disable();
      this.form.get('payment_mode')?.disable();
    } else {
      this._enableAllSystemFields();
    }
    this.dialogVisible.set(true);
  }

  private _enableAllSystemFields() {
    ['calc_type','payer','recipient','default_value','payment_mode'].forEach(f =>
      this.form.get(f)?.enable()
    );
  }

  /** Construye un Date con el mes y día dados (año actual, no se persiste). */
  private _buildPaymentDate(month: number | null, day: number | null): Date | null {
    if (!month) return null;
    const d = new Date();
    d.setMonth(month - 1);
    d.setDate(day ?? 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  save() {
    if (this.form.invalid) return;
    const raw = this.form.getRawValue();
    // Extraer month+day del Date seleccionado en el calendario
    let paymentMonth: number | null = null;
    let paymentDay:   number | null = null;
    if (raw.has_payment_date && raw.payment_date instanceof Date) {
      paymentMonth = raw.payment_date.getMonth() + 1;
      paymentDay   = raw.payment_date.getDate();
    }
    const payload: any = {
      name:          raw.name,
      description:   raw.description,
      calc_type:     raw.calc_type,
      // Convert percentage back to decimal before storing (8.33% → 0.0833)
      default_value: raw.calc_type === 'PERCENTAGE' && raw.default_value != null
        ? Math.round(raw.default_value / 100 * 1e6) / 1e6
        : raw.default_value,
      payer:         raw.payer,
      recipient:     raw.recipient,
      display_order: raw.display_order,
      payment_mode:  raw.payment_mode,
      payment_month: raw.has_payment_date ? paymentMonth : null,
      payment_day:   raw.has_payment_date ? paymentDay   : null,
    };
    this.saving.set(true);

    const id = this.editingId();
    const obs = id
      ? this.svc.updateObligationCatalogItem(id, payload)
      : this.svc.createObligationCatalogItem(payload);

    obs.subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Guardado', detail: id ? 'Obligación actualizada' : 'Obligación creada' });
        this.dialogVisible.set(false);
        this.saving.set(false);
        this.load();
      },
      error: (e) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: e?.error?.message ?? 'No se pudo guardar' });
        this.saving.set(false);
      },
    });
  }

  confirmDeactivate(item: ObligationCatalogItem) {
    this.confirm.confirm({
      header: 'Desactivar obligación',
      message: `¿Desactivar "${item.name}"? No podrá asignarse a nuevos empleados.`,
      acceptLabel: 'Desactivar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.svc.deactivateObligationCatalogItem(item.id).subscribe({
          next: () => {
            this.msg.add({ severity: 'info', summary: 'Desactivada', detail: item.name });
            this.load();
          },
          error: (e) => this.msg.add({ severity: 'error', summary: 'Error', detail: e?.error?.message ?? 'No se pudo desactivar' }),
        });
      },
    });
  }

  calcTypeLabel(type: string) {
    return type === 'PERCENTAGE' ? 'Porcentaje' : 'Valor fijo';
  }
  payerLabel(p: string) {
    return p === 'EMPLOYER' ? 'Patrono' : 'Empleado';
  }
  recipientLabel(r: string) {
    const map: Record<string, string> = { IESS: 'IESS', EMPLOYEE: 'Empleado', OTHER: 'Otro' };
    return map[r] ?? r;
  }

  paymentDateLabel(item: ObligationCatalogItem): string {
    if (!item.payment_month) return 'Mensual';
    const m = this.monthOptions.find(o => o.value === item.payment_month)?.label ?? '';
    return item.payment_day ? `${item.payment_day} de ${m}` : m;
  }
}
