import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { firstValueFrom, forkJoin } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
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
import { AliquotPayment, CondoExpensePeriod, ExpenseCategory, ExpenseType, OcrOwnerMatch, OcrScanResult, ProvisionCatalogItem } from '../../../shared/models/models';

interface PeriodLineItem {
  expenseItemId: string | null;
  name: string;
  category: ExpenseCategory;
  expenseType: ExpenseType;
  amount: number | null;
  selected: boolean;
  isRecurring: boolean;
  isAdHoc: boolean;
}

type BulkReceiptStatus = 'queued' | 'scanning' | 'ready' | 'error' | 'confirming' | 'confirmed';
interface BulkReceipt {
  file: File;
  status: BulkReceiptStatus;
  scan?: OcrScanResult;
  match?: OcrOwnerMatch;
  amount?: number;
  paymentDate?: string;
  error?: string;
  showManualAssignment?: boolean;
  manualPeriodId?: string;
  manualPeriod?: CondoExpensePeriod;
  manualPaymentId?: string;
  manualMatch?: OcrOwnerMatch;
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
    InputTextModule, DropdownModule,
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
  editingPeriod: CondoExpensePeriod | null = null;

  // ── Carga masiva de comprobantes ─────────────────────────
  showBulkUpload = false;
  loadingBulkPeriod = false;
  bulkProcessing = false;
  bulkPeriod: CondoExpensePeriod | null = null;
  bulkReceipts: BulkReceipt[] = [];
  manualPeriods: CondoExpensePeriod[] = [];
  loadingManualPeriods = false;

  // ── Dialog state ──────────────────────────────────────────
  selectedMonth = new Date().getMonth() + 1;
  selectedYear  = new Date().getFullYear();
  lineItems: PeriodLineItem[]  = [];
  adHocItems: PeriodLineItem[] = [];
  loadingItems = false;
  periodNotes  = '';

  // Provision selection (from catalog, toggled per-period)
  provisionCatalog: ProvisionCatalogItem[] = [];
  provisionItems: (ProvisionCatalogItem & { selected: boolean; customValue: number | null })[] = [];

  get provisionBreakdown(): { id: string; name: string; amount: number }[] {
    const selected = this.provisionItems.filter(p => p.selected);
    const fixedAndVariableTotal = selected.reduce((sum, p) => {
      const ct = p.calc_type as string;
      if (ct === 'FIXED') return sum + p.value;
      if (ct === 'VARIABLE') return sum + Number(p.customValue || 0);
      return sum;
    }, 0);
    const percentageBase = this.grandTotal + fixedAndVariableTotal;

    return selected.map(p => {
      const ct = p.calc_type as string;
      let amount: number;
      if (ct === 'FIXED') { amount = p.value; }
      else if (ct === 'VARIABLE') { amount = Number(p.customValue || 0); }
      else { amount = Math.round(percentageBase * p.value / 100 * 100) / 100; }
      return { id: p.id, name: p.name, amount };
    });
  }
  get totalProvisions():          number { return this.provisionBreakdown.reduce((s, p) => s + p.amount, 0); }
  get grandTotalWithProvisions(): number { return this.grandTotal + this.totalProvisions; }
  provisionAmount(id: string): number {
    return this.provisionBreakdown.find(p => p.id === id)?.amount ?? 0;
  }

  monthOptions = MONTHS.map((label, i) => ({ label, value: i + 1 }));
  yearOptions = Array.from({ length: 2050 - 1990 + 1 }, (_, i) => {
    const year = 1990 + i;
    return { label: String(year), value: year };
  }).reverse();
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
    this.editingPeriod = null;
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
          customValue: (p.calc_type as string) === 'VARIABLE' ? null : parseFloat(String(p.value)) || 0,
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
            amount:        i.expenseType === 'VARIABLE' && Number(i.amount || 0) === 0 ? null : i.amount,
            selected:      i.isRecurring,
            isRecurring:   i.isRecurring,
            isAdHoc:       false,
          }));
        this.loadingItems = false;
      },
      error: () => { this.lineItems = []; this.loadingItems = false; },
    });
  }

  openEditPeriod(period: CondoExpensePeriod) {
    if (period.status !== 'DRAFT') {
      this.msg.add({ severity: 'warn', summary: 'No editable', detail: 'Solo se pueden editar períodos en borrador.' });
      return;
    }
    this.editingPeriod = period;
    this.selectedMonth = period.month;
    this.selectedYear  = period.year;
    this.adHocItems    = [];
    this.lineItems     = [];
    this.periodNotes   = period.notes || '';
    this.loadingItems  = true;
    this.showDialog    = true;

    forkJoin({
      period:       this.svc.getPeriod(period.id),
      periodItems:  this.svc.getPeriodExpenseItems(period.id),
      items:        this.svc.getExpenseItems(),
      catalog:      this.svc.getProvisionCatalog(),
    }).subscribe({
      next: ({ period: fullPeriod, periodItems, items, catalog }) => {
        this.editingPeriod = fullPeriod;
        this.selectedMonth = fullPeriod.month;
        this.selectedYear  = fullPeriod.year;
        this.periodNotes   = fullPeriod.notes || '';

        const periodItemByCatalogId = new Map(
          periodItems
            .filter(item => item.expenseItemId)
            .map(item => [item.expenseItemId, item])
        );
        const existingCatalogIds = new Set(periodItemByCatalogId.keys());
        const catalogRows = items.items
          .filter(item => item.isActive || existingCatalogIds.has(item.id))
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map(item => {
            const saved = periodItemByCatalogId.get(item.id);
            return {
              expenseItemId: item.id,
              name:          saved?.name || item.name,
              category:      saved?.category || item.category,
              expenseType:   saved?.expenseType || item.expenseType,
              amount:        (saved?.expenseType || item.expenseType) === 'VARIABLE' && Number(saved?.amount ?? item.amount ?? 0) === 0
                ? null
                : saved?.amount ?? item.amount,
              selected:      !!saved,
              isRecurring:   item.isRecurring,
              isAdHoc:       false,
            };
          });
        const orphanCatalogRows = periodItems
          .filter(item => item.expenseItemId && !items.items.some(catalogItem => catalogItem.id === item.expenseItemId))
          .map(item => ({
            expenseItemId: item.expenseItemId || null,
            name:          item.name,
            category:      item.category,
            expenseType:   item.expenseType,
            amount:        item.expenseType === 'VARIABLE' && Number(item.amount || 0) === 0 ? null : item.amount,
            selected:      true,
            isRecurring:   false,
            isAdHoc:       false,
          }));
        this.lineItems = [...catalogRows, ...orphanCatalogRows];
        this.adHocItems = periodItems
          .filter(item => !item.expenseItemId)
          .map(item => ({
            expenseItemId: null,
            name:          item.name,
            category:      item.category,
            expenseType:   item.expenseType,
            amount:        item.amount,
            selected:      true,
            isRecurring:   false,
            isAdHoc:       true,
          }));

        const periodProvisionById = new Map(
          (fullPeriod.provisions || [])
            .filter(provision => provision.provisionId)
            .map(provision => [provision.provisionId, provision])
        );
        this.provisionCatalog = catalog;
        this.provisionItems = catalog.map(provision => {
          const saved = periodProvisionById.get(provision.id);
          const value = parseFloat(String(provision.value)) || 0;
          return {
            ...provision,
            value,
            customValue: (provision.calc_type as string) === 'VARIABLE'
              ? (saved && Number(saved.amount || 0) > 0 ? Number(saved.amount) : null)
              : (saved ? Number(saved.amount || 0) : value),
            selected: !!saved,
          };
        });
        this.loadingItems = false;
      },
      error: err => {
        this.loadingItems = false;
        this.showDialog = false;
        this.msg.add({ severity: 'error', summary: 'No se pudo cargar el período', detail: err.error?.message || 'Intenta nuevamente.' });
      },
    });
  }

  addAdHoc() {
    this.adHocItems.push({
      expenseItemId: null, name: '', category: 'OTHER',
      expenseType: 'VARIABLE', amount: null,
      selected: true, isRecurring: false, isAdHoc: true,
    });
  }

  removeAdHoc(i: number) { this.adHocItems.splice(i, 1); }

  private periodPayload() {
    const items = [
      ...this.lineItems.filter(i => i.selected),
      ...this.adHocItems.filter(i => Number(i.amount || 0) > 0 && i.name.trim()),
    ].map(i => ({
      expenseItemId: i.expenseItemId,
      name:          i.name || 'Gasto',
      category:      i.category,
      expenseType:   i.expenseType,
      amount:        Number(i.amount || 0),
    }));

    const selectedProvisions = this.provisionItems.filter(p => p.selected);
    const provisionAmounts: Record<string, number> = {};
    for (const p of selectedProvisions) {
      if ((p.calc_type as string) === 'VARIABLE') provisionAmounts[p.id] = Number(p.customValue || 0);
    }

    return {
      month: this.selectedMonth,
      year: this.selectedYear,
      items,
      notes:            this.periodNotes || undefined,
      provisionIds:     selectedProvisions.map(p => p.id),
      provisionAmounts: Object.keys(provisionAmounts).length ? provisionAmounts : undefined,
    };
  }

  savePeriod() {
    if (this.editingPeriod) {
      this.updatePeriod();
    } else {
      this.create();
    }
  }

  create() {
    if (this.grandTotal === 0) return;
    this.saving = true;
    this.svc.createPeriod(this.periodPayload()).subscribe({
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

  updatePeriod() {
    if (!this.editingPeriod || this.grandTotal === 0) return;
    this.saving = true;
    const periodName = `${this.monthName(this.selectedMonth)} ${this.selectedYear}`;
    this.svc.updatePeriod(this.editingPeriod.id, this.periodPayload()).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Período actualizado', detail: periodName });
        this.showDialog = false;
        this.saving = false;
        this.editingPeriod = null;
        this.load();
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

  periodStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      DRAFT: 'Borrador',
      APPROVED: 'Aprobado',
      CLOSED: 'Cerrado',
    };
    return labels[status] || status;
  }

  fixedSum(p: any): number {
    return ((p.fixed_maintenance || 0) + (p.fixed_security || 0) +
            (p.fixed_cleaning    || 0) + (p.fixed_other    || 0));
  }

  effectiveTotal(p: any): number {
    return parseFloat(p.grand_total) > 0 ? parseFloat(p.grand_total) : parseFloat(p.total_expenses) || 0;
  }

  goToExpenses() { this.router.navigate(['/condominium/expenses']); }

  openBulkUpload(period: CondoExpensePeriod) {
    this.loadingBulkPeriod = true;
    this.svc.getPeriod(period.id).subscribe({
      next: fullPeriod => {
        this.loadingBulkPeriod = false;
        if (!fullPeriod.payments?.length) {
          this.msg.add({ severity: 'warn', summary: 'Sin alícuotas', detail: 'Primero genera las alícuotas de este período.' });
          return;
        }
        if (fullPeriod.status === 'CLOSED') {
          this.msg.add({ severity: 'warn', summary: 'Período cerrado', detail: 'No se pueden registrar más pagos.' });
          return;
        }
        this.bulkPeriod = fullPeriod;
        this.bulkReceipts = [];
        this.showBulkUpload = true;
      },
      error: err => {
        this.loadingBulkPeriod = false;
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message || 'No se pudo cargar el período.' });
      },
    });
  }

  onBulkFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length || !this.bulkPeriod) return;

    this.bulkReceipts.push(...files.map(file => ({ file, status: 'queued' as const })));
    input.value = '';
    void this.processBulkQueue();
  }

  private async processBulkQueue() {
    if (this.bulkProcessing || !this.bulkPeriod) return;
    this.bulkProcessing = true;
    try {
      for (const receipt of this.bulkReceipts) {
        if (receipt.status !== 'queued') continue;
        receipt.status = 'scanning';
        try {
          const scan = await firstValueFrom(this.svc.scanPaymentProof(receipt.file, this.bulkPeriod.id));
          receipt.scan = scan;
          receipt.match = scan.matches.length === 1 ? scan.matches[0] : undefined;
          receipt.amount = this.readAmount(scan.extractedData.amount);
          receipt.paymentDate = this.toIsoDate(scan.extractedData.date);
          receipt.status = 'ready';
        } catch (err: any) {
          receipt.status = 'error';
          receipt.error = err.error?.message || 'No se pudo leer el comprobante.';
        }
      }
    } finally {
      this.bulkProcessing = false;
    }
  }

  private readAmount(value: unknown): number | undefined {
    const amount = typeof value === 'number'
      ? value
      : Number(String(value ?? '').replace(/[$\s]/g, '').replace(',', '.'));
    return Number.isFinite(amount) && amount > 0 ? amount : undefined;
  }

  private toIsoDate(value: unknown): string | undefined {
    const date = String(value || '').trim();
    const slash = date.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  }

  isReceiptDateInPeriod(receipt: BulkReceipt): boolean {
    const period = receipt.manualPeriod || this.bulkPeriod;
    return !!period && !!receipt.paymentDate &&
      receipt.paymentDate.slice(0, 7) === `${period.year}-${String(period.month).padStart(2, '0')}`;
  }

  canConfirmReceipt(receipt: BulkReceipt): boolean {
    const match = this.receiptMatch(receipt);
    return !!match && match.paymentStatus !== 'PAID' &&
      !!receipt.amount && this.isReceiptDateInPeriod(receipt) && receipt.status === 'ready';
  }

  receiptMatch(receipt: BulkReceipt): OcrOwnerMatch | undefined {
    return receipt.manualMatch || receipt.match;
  }

  receiptTargetPeriod(receipt: BulkReceipt): CondoExpensePeriod | null {
    return receipt.manualPeriod || this.bulkPeriod;
  }

  pendingAmount(receipt: BulkReceipt): number {
    const match = this.receiptMatch(receipt);
    return match ? Math.max(0, match.totalDue - match.amountPaid) : 0;
  }

  openManualAssignment(receipt: BulkReceipt) {
    receipt.showManualAssignment = true;
    if (receipt.status === 'error') receipt.status = 'ready';
    if (this.manualPeriods.length || this.loadingManualPeriods) return;
    this.loadingManualPeriods = true;
    this.svc.getPeriods().subscribe({
      next: periods => { this.manualPeriods = periods.filter(p => p.status !== 'CLOSED'); this.loadingManualPeriods = false; },
      error: () => {
        this.loadingManualPeriods = false;
        receipt.error = 'No se pudieron cargar los períodos.';
      },
    });
  }

  onManualPeriodSelected(receipt: BulkReceipt) {
    receipt.manualPaymentId = undefined;
    receipt.manualMatch = undefined;
    receipt.manualPeriod = undefined;
    if (!receipt.manualPeriodId) return;
    this.svc.getPeriod(receipt.manualPeriodId).subscribe({
      next: period => receipt.manualPeriod = period,
      error: err => receipt.error = err.error?.message || 'No se pudieron cargar las alícuotas.',
    });
  }

  onManualPaymentSelected(receipt: BulkReceipt) {
    const payment = receipt.manualPeriod?.payments?.find(p => p.id === receipt.manualPaymentId);
    receipt.manualMatch = payment ? this.asOcrMatch(payment) : undefined;
  }

  private asOcrMatch(payment: AliquotPayment): OcrOwnerMatch {
    return {
      paymentId: payment.id, paymentStatus: payment.status,
      aliquotAmount: payment.aliquotAmount, moraAtBilling: payment.moraAtBilling,
      amountPaid: payment.amountPaid, totalDue: payment.totalDue,
      owner: {
        id: payment.ownerId,
        fullName: payment.owner?.fullName || 'Propietario',
        apartmentNumber: payment.owner?.apartmentNumber || '—',
      },
    };
  }

  ocrConfidence(receipt: BulkReceipt): number | null {
    const confidence = receipt.scan?.extractedData.confidence_score;
    return typeof confidence === 'number' ? confidence : null;
  }

  confirmReceipt(receipt: BulkReceipt) {
    const match = this.receiptMatch(receipt);
    const targetPeriod = receipt.manualPeriod || this.bulkPeriod;
    if (!targetPeriod || !match || !this.canConfirmReceipt(receipt)) return;
    const periodName = `${this.monthName(targetPeriod.month)} ${targetPeriod.year}`;
    this.confirm.confirm({
      header: 'Confirmar pago detectado',
      message: `Se registrará $${receipt.amount!.toFixed(2)} en la alícuota de ${periodName}, departamento ${match.owner.apartmentNumber}, con fecha ${receipt.paymentDate}. Verifica que corresponde a este mes antes de continuar.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: `Confirmar depto. ${match.owner.apartmentNumber}`,
      rejectLabel: 'Cancelar',
      accept: () => this.persistReceipt(receipt),
    });
  }

  private persistReceipt(receipt: BulkReceipt) {
    const match = this.receiptMatch(receipt);
    if (!match || !receipt.amount || !receipt.paymentDate) return;
    receipt.status = 'confirming';
    this.svc.confirmOcrPayment(match.paymentId, receipt.file, {
      amount: receipt.amount,
      paymentDate: receipt.paymentDate,
      ocrSenderName: receipt.scan?.extractedData.sender_name,
      ocrBank: receipt.scan?.extractedData.bank,
    }).subscribe({
      next: () => {
        receipt.status = 'confirmed';
        this.load();
        this.msg.add({ severity: 'success', summary: 'Pago registrado', detail: `Departamento ${match.owner.apartmentNumber}` });
      },
      error: err => {
        receipt.status = 'ready';
        receipt.error = err.error?.message || 'No se pudo guardar el pago.';
        this.msg.add({ severity: 'error', summary: 'No se registró el pago', detail: receipt.error });
      },
    });
  }

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
