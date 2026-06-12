import {
  Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, signal, computed,
} from '@angular/core';
import { CommonModule }       from '@angular/common';
import { RouterModule }       from '@angular/router';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup } from '@angular/forms';
import { TableModule }        from 'primeng/table';
import { ButtonModule }       from 'primeng/button';
import { InputTextModule }    from 'primeng/inputtext';
import { InputNumberModule }  from 'primeng/inputnumber';
import { CheckboxModule }     from 'primeng/checkbox';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DialogModule }       from 'primeng/dialog';
import { TagModule }          from 'primeng/tag';
import { ToastModule }        from 'primeng/toast';
import { TooltipModule }      from 'primeng/tooltip';
import { MessageService }     from 'primeng/api';
import { EmployeeService }    from '../../../shared/models/employee.service';
import {
  ObligationCatalogItem,
  EmployeeObligationValue,
  ObligationUpsertItem,
} from '../../../shared/models/obligation.model';
import { forkJoin }           from 'rxjs';

@Component({
  selector: 'app-labor-obligations-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl:    './labor-obligations-list.component.css',
  templateUrl: './labor-obligations-list.component.html',
  imports: [
    CommonModule, RouterModule, FormsModule, ReactiveFormsModule,
    TableModule, ButtonModule, InputTextModule, InputNumberModule,
    CheckboxModule, SelectButtonModule, DialogModule, TagModule, ToastModule, TooltipModule,
  ],
  providers: [MessageService],
})
export class LaborObligationsListComponent implements OnInit {
  rows     = signal<any[]>([]);
  total    = signal(0);
  loading  = signal(false);
  saving   = signal(false);
  search   = '';
  page     = 1;

  catalog  = signal<ObligationCatalogItem[]>([]);

  /** Pre-computed pay-frequency options per catalog item (avoids new array on every render). */
  payFreqOptionsMap: Record<string, { label: string; value: string }[]> = {};

  // Stats (computed dynamically from rows)
  totalEmployerMonthly = computed(() =>
    Math.round(this.rows().reduce((s, r) => {
      const empObls: EmployeeObligationValue[] = r.obligations ?? [];
      return s + empObls
        .filter(o => o.payer === 'EMPLOYER' && o.is_active)
        .reduce((a, o) => a + o.effective_value, 0);
    }, 0) * 100) / 100
  );
  totalEmployeeDeductions = computed(() =>
    Math.round(this.rows().reduce((s, r) => {
      const empObls: EmployeeObligationValue[] = r.obligations ?? [];
      return s + empObls
        .filter(o => o.payer === 'EMPLOYEE' && o.is_active)
        .reduce((a, o) => a + o.effective_value, 0);
    }, 0) * 100) / 100
  );
  countFondos = computed(() =>
    this.rows().filter(r =>
      (r.obligations ?? []).some((o: EmployeeObligationValue) => o.code === 'FONDO_RESERVA' && o.is_active)
    ).length
  );
  totalIessMonthly = computed(() =>
    Math.round(this.rows().reduce((s, r) => s + parseFloat(r.total_iess_monthly || 0), 0) * 100) / 100
  );

  // Edit dialog
  dialogVisible = signal(false);
  selected      = signal<any>(null);
  /** Per-obligation form controls: { [obligation_id]: FormGroup({ is_active, override_value, payout_mode }) } */
  oblControls: Record<string, FormGroup> = {};

  payoutModeOptions = [
    { label: 'Al IESS (acumular)', value: 'IESS' },
    { label: 'Al empleado (mensual)', value: 'MONTHLY' },
  ];

  monthOptions = [
    { label: 'Enero',      value: 1  }, { label: 'Febrero',   value: 2  },
    { label: 'Marzo',      value: 3  }, { label: 'Abril',      value: 4  },
    { label: 'Mayo',       value: 5  }, { label: 'Junio',      value: 6  },
    { label: 'Julio',      value: 7  }, { label: 'Agosto',     value: 8  },
    { label: 'Septiembre', value: 9  }, { label: 'Octubre',    value: 10 },
    { label: 'Noviembre',  value: 11 }, { label: 'Diciembre',  value: 12 },
  ];

  constructor(
    private svc: EmployeeService,
    private fb: FormBuilder,
    private msg: MessageService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit() { this.loadAll(); }

  loadAll() {
    this.loading.set(true);
    forkJoin({
      catalog: this.svc.getObligationCatalog(),
      rows:    this.svc.listAllObligations({ page: this.page, limit: 50, search: this.search }),
    }).subscribe({
      next: ({ catalog, rows }) => {
        this.catalog.set(catalog.data ?? []);
        this.rows.set(rows.data ?? []);
        this.total.set(rows.pagination?.total ?? (rows.data ?? []).length);
        // Pre-compute SelectButton options once per catalog load
        this.payFreqOptionsMap = {};
        for (const cat of (catalog.data ?? [])) {
          if (cat.payment_mode === 'LUMP_SUM') {
            const dateLabel = (cat.payment_month && cat.payment_day)
              ? `Pago único anual (${cat.payment_day}/${cat.payment_month})`
              : cat.payment_month
                ? `Pago único anual (mes ${cat.payment_month})`
                : 'Pago único anual';
            this.payFreqOptionsMap[cat.id] = [
              { label: dateLabel,             value: 'CATALOG' },
              { label: '12 cuotas mensuales', value: 'MONTHLY' },
            ];
          }
        }
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  load() { this.loadAll(); }
  onSearch() { this.page = 1; this.loadAll(); }

  /** Returns the EmployeeObligationValue for a given catalog item from a row. */
  getObl(row: any, cat: ObligationCatalogItem): EmployeeObligationValue | undefined {
    return (row.obligations ?? []).find((o: EmployeeObligationValue) => o.obligation_id === cat.id);
  }

  /** Returns the displayed effective value for a cell (or null to show '—'). */
  getCellValue(row: any, cat: ObligationCatalogItem): number | null {
    const o = this.getObl(row, cat);
    if (!o || !o.is_active) return null;
    return o.effective_value;
  }

  /** Returns the FormGroup for a catalog item's controls (used in template). */
  getFg(catId: string): FormGroup | null {
    return this.oblControls[catId] ?? null;
  }

  openEdit(row: any) {
    this.selected.set(row);
    this.oblControls = {};
    const catalog = this.catalog();
    const empObls: EmployeeObligationValue[] = row.obligations ?? [];

    catalog.forEach(cat => {
      const empObl = empObls.find(o => o.obligation_id === cat.id);
      const fg = this.fb.group({
        is_active:      [empObl?.is_active ?? false],
        // System items: never store override — always use catalog default_value
        // Non-system PERCENTAGE: stored as decimal (0.0833), shown as whole% (8.33) in form
        override_value: cat.is_system
          ? null
          : (empObl?.override_value != null
              ? (cat.calc_type === 'PERCENTAGE'
                  ? Math.round(parseFloat(String(empObl.override_value)) * 10000) / 100  // 0.0833 → 8.33
                  : parseFloat(String(empObl.override_value)))
              : null),
        payout_mode:    [empObl?.payout_mode ?? 'IESS'],
        prefer_monthly: [empObl?.prefer_monthly ? 'MONTHLY' : 'CATALOG'],
      });
      this.oblControls[cat.id] = fg;
    });

    this.dialogVisible.set(true);
  }

  oblFormValue(catId: string) { return this.oblControls[catId]?.value; }

  /** Called when the user changes prefer_monthly via SelectButton. Forces re-render on OnPush. */
  onPreferMonthlyChange(catId: string, value: string) {
    this.oblControls[catId]?.get('prefer_monthly')?.setValue(value, { emitEvent: false });
    this.cdr.markForCheck();
  }

  get baseSalaryForDialog(): number {
    return parseFloat(this.selected()?.base_salary || 0);
  }

  /** Live preview of effective value for an obligation in the dialog. */
  previewEffectiveValue(cat: ObligationCatalogItem): number {
    const fg = this.oblControls[cat.id];
    console.log('Preview', cat.name, 'fg value:', fg?.value);
    if (!fg || !fg.value.is_active) return 0;
    if (cat.calc_type === 'PERCENTAGE') {
      // System items always use catalog default_value (decimal); no employee override allowed
      // Non-system: form stores whole% (8.33) → divide by 100 for calculation
      const rate = (!cat.is_system && fg.value.override_value != null)
        ? fg.value.override_value / 100
        : (cat.default_value != null ? parseFloat(String(cat.default_value)) : 0);
      return Math.round(this.baseSalaryForDialog * rate * 100) / 100;
    }
    return Math.round((fg.value.override_value ?? 0) * 100) / 100;
  }

  get previewTotalIess(): number {
    return Math.round(
      this.catalog().reduce((s, cat) => s + this.previewEffectiveValue(cat), 0) * 100
    ) / 100;
  }

  saveEdit() {
    const emp = this.selected();
    if (!emp) return;

    const obligations: ObligationUpsertItem[] = this.catalog().map(cat => {
      const fg = this.oblControls[cat.id];
      const v  = fg?.value ?? {};
      return {
        obligation_id:  cat.id,
        is_active:      v.is_active      ?? false,
        // System items: always send null override (backend uses catalog default_value)
        // Non-system PERCENTAGE: convert whole% back to decimal (8.33 → 0.0833)
        override_value: cat.is_system
          ? null
          : (v.override_value != null
              ? (cat.calc_type === 'PERCENTAGE'
                  ? Math.round(v.override_value / 100 * 1e6) / 1e6
                  : v.override_value)
              : null),
        payout_mode:    v.payout_mode    ?? null,
        prefer_monthly: v.prefer_monthly === 'MONTHLY',
        notes:          null,
      };
    });

    this.saving.set(true);
    this.svc.updateEmployeeObligations(emp.id, obligations).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Guardado', detail: `Obligaciones de ${emp.first_name} ${emp.last_name} actualizadas` });
        this.dialogVisible.set(false);
        this.saving.set(false);
        this.loadAll();
      },
      error: () => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar' });
        this.saving.set(false);
      },
    });
  }
}
