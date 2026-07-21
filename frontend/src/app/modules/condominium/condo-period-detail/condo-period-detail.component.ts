import { Component, ElementRef, inject, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { firstValueFrom, forkJoin } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { CalendarModule } from 'primeng/calendar';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { FileUploadModule } from 'primeng/fileupload';
import { ImageModule } from 'primeng/image';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { DropdownModule } from 'primeng/dropdown';
import { MenuModule } from 'primeng/menu';
import { MessageService, ConfirmationService, MenuItem } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { AliquotPayment, AliquotPaymentRecord, CondoExpensePeriod, CondoPeriodExpenseItem, OcrOwnerMatch, OcrScanResult, PaymentExtra, PaymentStatus } from '../../../shared/models/models';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  MAINTENANCE: 'Mantenimiento',
  SECURITY: 'Seguridad',
  CLEANING: 'Limpieza',
  UTILITIES: 'Servicios básicos',
  ADMINISTRATION: 'Administración',
  OTHER: 'Otros',
};
type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;
type BulkReceiptStatus = 'queued' | 'scanning' | 'ready' | 'error' | 'confirming' | 'confirmed';
type BulkReceiptSource = 'receipt' | 'movement-pdf' | 'movement-row';

interface BulkReceipt {
  id?: string;
  file: File;
  source?: BulkReceiptSource;
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
  description?: string;
  suggestedByAmount?: boolean;
  movementProofUrl?: string;
  movementProofPublicId?: string;
}

interface AliquotPreviewRow {
  ownerId: string;
  apartmentNumber: string;
  fullName: string;
  participationPct: number;
  amount: number;
}

@Component({
  selector: 'app-condo-period-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, RouterModule,
    TableModule, ButtonModule, DialogModule, InputTextModule,
    CalendarModule, TagModule, TooltipModule, ToastModule, ConfirmDialogModule,
    FileUploadModule, ImageModule, InputTextareaModule, DropdownModule, MenuModule],
  providers: [MessageService, ConfirmationService],
  templateUrl: './condo-period-detail.component.html',
  styleUrl: './condo-period-detail.component.css',
})
export class CondoPeriodDetailComponent implements OnInit, OnDestroy {
  @ViewChild('movementPdfInput') movementPdfInput?: ElementRef<HTMLInputElement>;

  private route = inject(ActivatedRoute);
  private svc = inject(CondominiumService);
  private fb = inject(FormBuilder);
  private msg = inject(MessageService);
  private confirm = inject(ConfirmationService);
  private sanitizer = inject(DomSanitizer);

  period: CondoExpensePeriod | null = null;
  expenseItems: CondoPeriodExpenseItem[] = [];
  loading = false; generating = false; sending = false; closing = false;
  saving = false; uploadingProof = false; deletingProof = false;
  sendingPaymentId: string | null = null;

  showPaymentDialog = false;
  showProofDialog   = false;
  showExtraDialog   = false;
  showBulkUpload    = false;
  showProofPreview  = false;
  showPeriodDetails = false;
  showAliquotPreview = false;
  showAliquotPreviewDetails = false;
  showMoraProofsDialog = false;
  showPaymentRecordsDialog = false;
  selectedPayment: AliquotPayment | null = null;
  selectedMoraProofPayment: AliquotPayment | null = null;
  selectedPaymentRecordsPayment: AliquotPayment | null = null;
  selectedFile: File | null = null;
  proofPreviewUrl = '';
  proofPreviewResource: SafeResourceUrl | null = null;
  proofPreviewIsPdf = false;
  private proofPreviewObjectUrl: string | null = null;
  bulkProcessing = false;
  importingMovements = false;
  showMovementLoading = false;
  bulkReceipts: BulkReceipt[] = [];
  movementPdfFile: File | null = null;
  manualPeriods: CondoExpensePeriod[] = [];
  loadingManualPeriods = false;
  loadingAliquotPreview = false;
  aliquotPreviewRows: AliquotPreviewRow[] = [];
  aliquotPreviewBase = 0;
  aliquotPreviewParticipation = 0;

  // ── Extras ─────────────────────────────────────────────
  savingExtra   = false;
  deletingExtra: string | null = null;  // ID del extra que se está borrando
  editingExtra:  PaymentExtra | null = null;
  newExtraAmount: number | null = null;
  newExtraNotes  = '';
  editExtraAmount = 0;
  editExtraNotes  = '';

  paymentForm = this.fb.group({
    amountPaid: [null as number | null, [Validators.required, Validators.min(0.01)]],
    paymentDate: [null as Date | null, Validators.required],
    paymentMonth: ['', [Validators.required, Validators.pattern(/^\d{4}-\d{2}$/)]],
    notes: [''],
  });

  get monthName() { return this.period ? MONTHS[this.period.month - 1] : ''; }
  get fixedSum(): number {
    if (this.expenseItems.length > 0) {
      return this.expenseItems
        .filter(i => i.expenseType === 'FIXED')
        .reduce((s, i) => s + i.amount, 0);
    }
    // Fallback for periods without stored expense items
    if (!this.period) return 0;
    return (this.period.fixed_maintenance || 0) + (this.period.fixed_security || 0) +
           (this.period.fixed_cleaning    || 0) + (this.period.fixed_other    || 0);
  }

  get variableSum(): number {
    if (this.expenseItems.length > 0) {
      return this.expenseItems
        .filter(i => i.expenseType === 'VARIABLE')
        .reduce((s, i) => s + i.amount, 0);
    }
    return parseFloat(String(this.period?.variable_expenses || 0));
  }

  periodPending(payment: AliquotPayment): number {
    return Math.max(0, payment.totalDue - payment.amountPaid);
  }

  isOverduePaymentSettled(payment: AliquotPayment): boolean {
    return !!payment.wasOverdue && this.periodPending(payment) <= 0.01;
  }

  get enteredPaymentAmount(): number {
    return Number(this.paymentForm.controls.amountPaid.value || 0);
  }

  get ownerMoraAvailable(): number {
    return Number(this.selectedPayment?.owner?.moraAmount || 0);
  }

  get moraToApply(): number {
    return Math.min(this.enteredPaymentAmount, this.ownerMoraAvailable);
  }

  get finalMoraAfterPayment(): number {
    return Math.max(0, this.ownerMoraAvailable - this.moraToApply);
  }

  get isSelectedPeriodClosed(): boolean {
    return this.period?.status === 'CLOSED';
  }

  get canManageExtras(): boolean {
    return this.period?.status !== 'CLOSED' && this.selectedPayment?.status !== 'PAID';
  }

  canManagePaymentExtras(payment: AliquotPayment): boolean {
    return this.period?.status !== 'CLOSED' && payment.status !== 'PAID';
  }

  get periodProvisions() {
    return this.period?.provisions || [];
  }

  get canConfirmAliquotPreview(): boolean {
    return this.aliquotPreviewRows.length > 0 &&
      !this.hasInvalidAliquotPreviewParticipation &&
      !this.generating;
  }

  get hasInvalidAliquotPreviewParticipation(): boolean {
    return Math.abs(this.aliquotPreviewParticipation - 100) > 0.01;
  }

  get canManagePeriodPayments(): boolean {
    return !!this.period?.payments?.length && this.period.status !== 'CLOSED';
  }

  get headerActionItems(): MenuItem[] {
    const actions: MenuItem[] = [
      {
        label: 'Ver detalles',
        icon: 'pi pi-info-circle',
        styleClass: 'period-action-detail',
        command: () => this.showPeriodDetails = true,
      },
    ];

    if (this.canManagePeriodPayments) {
      actions.push(
        {
          label: 'Importar movimientos PDF',
          icon: this.importingMovements ? 'pi pi-spin pi-spinner' : 'pi pi-file-pdf',
          styleClass: 'period-action-pdf',
          disabled: this.importingMovements,
          command: () => this.openMovementPdfPicker(),
        },
        {
          label: 'Enviar correos',
          icon: this.sending ? 'pi pi-spin pi-spinner' : 'pi pi-send',
          styleClass: 'period-action-success',
          disabled: this.sending,
          command: () => this.sendEmails(),
        },
      );
    }

    if (this.period?.status === 'APPROVED') {
      actions.push(
        { separator: true },
        {
          label: 'Cerrar período',
          icon: this.closing ? 'pi pi-spin pi-spinner' : 'pi pi-lock',
          styleClass: 'period-action-warning',
          disabled: this.closing,
          command: () => this.confirmClose(),
        },
      );
    }

    return actions;
  }

  get amountForCurrentPeriod(): number {
    if (this.isSelectedPeriodClosed) return 0;
    return this.selectedPayment
      ? Math.min(Math.max(0, this.enteredPaymentAmount - this.moraToApply), this.periodPending(this.selectedPayment))
      : 0;
  }

  get hasMoraPriority(): boolean {
    return this.ownerMoraAvailable > 0;
  }

  get paymentAmountAllowed(): boolean {
    if (!this.selectedPayment) return false;
    const maxAllowed = this.isSelectedPeriodClosed
      ? this.ownerMoraAvailable
      : this.periodPending(this.selectedPayment) + this.ownerMoraAvailable;
    return this.enteredPaymentAmount <= maxAllowed + 0.01;
  }

  ngOnInit() {
    this.route.params.subscribe(p => this.loadPeriod(p['id']));
  }

  ngOnDestroy() {
    this.revokeProofPreviewObjectUrl();
  }

  loadPeriod(id: string) {
    this.loading = true;
    forkJoin({
      period:       this.svc.getPeriod(id),
      expenseItems: this.svc.getPeriodExpenseItems(id),
    }).subscribe({
      next: ({ period, expenseItems }) => {
        this.period = {
          ...period,
          payments: [...(period.payments || [])].sort((first, second) =>
            String(first.owner?.apartmentNumber || '').localeCompare(
              String(second.owner?.apartmentNumber || ''),
              'es',
              { numeric: true, sensitivity: 'base' },
            ),
          ),
        };
        this.expenseItems = expenseItems;
        this.loading      = false;
      },
      error: () => this.loading = false,
    });
  }

  openAliquotPreview() {
    if (!this.period) return;
    this.loadingAliquotPreview = true;
    this.showAliquotPreview = true;
    this.showAliquotPreviewDetails = false;
    this.aliquotPreviewRows = [];
    this.aliquotPreviewBase = Number(this.period.grand_total || 0) > 0
      ? Number(this.period.grand_total)
      : Number(this.period.total_expenses || 0);

    this.svc.getOwners(true).subscribe({
      next: ({ owners }) => {
        const activeOwners = owners
          .filter(owner => owner.isActive)
          .sort((first, second) =>
            String(first.apartmentNumber || '').localeCompare(
              String(second.apartmentNumber || ''),
              'es',
              { numeric: true, sensitivity: 'base' },
            ),
          );
        this.aliquotPreviewParticipation = Math.round(
          activeOwners.reduce((sum, owner) => sum + Number(owner.participationPct || 0), 0) * 100
        ) / 100;
        this.aliquotPreviewRows = activeOwners.map(owner => ({
          ownerId: owner.id,
          apartmentNumber: owner.apartmentNumber,
          fullName: owner.fullName,
          participationPct: Number(owner.participationPct || 0),
          amount: Math.round(this.aliquotPreviewBase * Number(owner.participationPct || 0) / 100 * 100) / 100,
        }));
        this.loadingAliquotPreview = false;
      },
      error: err => {
        this.loadingAliquotPreview = false;
        this.msg.add({ severity: 'error', summary: 'No se pudo previsualizar', detail: err.error?.message || 'Intenta nuevamente.' });
      },
    });
  }

  generate() {
    if (!this.period || !this.canConfirmAliquotPreview) return;
    this.generating = true;
    const id = this.period.id;
    this.svc.generateAliquots(id).subscribe({
      next: () => {
        this.generating = false;
        this.showAliquotPreview = false;
        this.msg.add({ severity: 'success', summary: 'Alícuotas generadas' });
        this.loadPeriod(id);
      },
      error: (err) => { this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }); this.generating = false; },
    });
  }

  sendEmails() {
    if (!this.period) return;
    this.sending = true;
    this.svc.sendAliquotEmails(this.period.id).subscribe({
      next: (r) => {
        const skipped = r.skippedWithoutEmail || 0;
        this.msg.add({
          severity: 'success',
          summary: `${r.sent} correos enviados`,
          detail: skipped ? `${skipped} propietario(s) sin correo registrado.` : '',
        });
        this.sending = false;
      },
      error: err => {
        this.sending = false;
        this.msg.add({
          severity: 'error',
          summary: 'No se pudieron enviar los correos',
          detail: err.error?.message || 'Revisa la configuración SMTP/OAuth2 de Outlook.',
        });
      },
    });
  }

  sendEmailToPayment(payment: AliquotPayment) {
    if (!this.period || this.sendingPaymentId || !payment.owner?.email) return;
    this.sendingPaymentId = payment.id;
    this.svc.sendAliquotEmail(this.period.id, payment.id).subscribe({
      next: r => {
        this.msg.add({
          severity: 'success',
          summary: 'Correo enviado',
          detail: `Depto. ${r.unitNumber} — ${r.ownerEmail}`,
        });
        this.sendingPaymentId = null;
      },
      error: err => {
        this.sendingPaymentId = null;
        this.msg.add({
          severity: 'error',
          summary: 'No se pudo enviar el correo',
          detail: err.error?.message || 'Revisa la configuración SMTP/OAuth2 de Outlook.',
        });
      },
    });
  }

  confirmClose() {
    this.confirm.confirm({
      header: 'Cerrar período',
      message: 'Los pagos pendientes se marcarán como mora y se acumulará en el saldo de cada propietario. ¿Continuar?',
      accept: () => this.closePeriod(),
    });
  }

  closePeriod() {
    if (!this.period) return;
    this.closing = true;
    this.svc.closePeriod(this.period.id).subscribe({
      next: () => {
        this.closing = false;
        this.msg.add({ severity: 'info', summary: 'Período cerrado', detail: '' });
        this.loadPeriod(this.period!.id);
      },
      error: (err) => {
        this.closing = false;
        this.msg.add({ severity: 'error', summary: 'No se pudo cerrar el período', detail: err.error?.message || 'Intenta nuevamente.' });
      },
    });
  }

  // ── Carga masiva de comprobantes ─────────────────────────
  openBulkUpload() {
    if (!this.period?.payments?.length) {
      this.msg.add({ severity: 'warn', summary: 'Sin alícuotas', detail: 'Primero genera las alícuotas de este período.' });
      return;
    }
    this.bulkReceipts = [];
    this.showBulkUpload = true;
  }

  onBulkFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length || !this.period) return;
    this.bulkReceipts.push(...files.map(file => ({ file, source: 'receipt' as const, status: 'queued' as const })));
    input.value = '';
    void this.processBulkQueue();
  }

  onMovementPdfSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.period) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      this.msg.add({ severity: 'warn', summary: 'Archivo inválido', detail: 'Selecciona un archivo PDF de movimientos.' });
      return;
    }

    this.movementPdfFile = file;
    this.importMovementPdf(file);
  }

  openMovementPdfPicker() {
    this.movementPdfInput?.nativeElement.click();
  }

  private importMovementPdf(file: File) {
    if (!this.period) return;
    this.importingMovements = true;
    this.showMovementLoading = true;
    this.bulkReceipts = [];
    this.svc.importMovementPdf(file, this.period.id).subscribe({
      next: result => {
        const receipts: BulkReceipt[] = result.transactions.map((transaction, index) => {
          const scan: OcrScanResult = {
            filename: result.filename,
            extractedData: {
              sender_name: transaction.description,
              amount: transaction.amount,
              date: transaction.paymentDate,
              bank: 'Movimientos bancarios',
            },
            matches: transaction.matches,
            suggestedMatches: transaction.suggestedMatches,
          };
          return {
            id: `${transaction.id}-${Date.now()}-${index}`,
            file,
            source: 'movement-row',
            status: 'ready',
            scan,
            match: transaction.matches.length === 1
              ? transaction.matches[0]
              : transaction.suggestedMatches?.length === 1
                ? transaction.suggestedMatches[0]
                : undefined,
            amount: transaction.amount,
            paymentDate: transaction.paymentDate,
            description: transaction.description,
            suggestedByAmount: transaction.matches.length === 0 && transaction.suggestedMatches?.length === 1,
            movementProofUrl: result.proofUrl,
            movementProofPublicId: result.proofPublicId,
          };
        });
        this.bulkReceipts = receipts;
        this.showBulkUpload = true;
        this.msg.add({
          severity: receipts.length ? 'success' : 'warn',
          summary: receipts.length ? 'Pagos cargados' : 'Sin ingresos',
          detail: receipts.length
            ? `${receipts.length} ingreso(s) encontrado(s). Confirma cada pago antes de registrarlo.`
            : 'No se encontraron ingresos (+) para registrar.',
        });
      },
      error: err => {
        const message = err.error?.message || 'Intenta nuevamente con el PDF de movimientos.';
        this.bulkReceipts = [{
          id: `movement-error-${Date.now()}`,
          file,
          source: 'movement-pdf',
          status: 'error',
          error: message,
          description: 'PDF de movimientos',
        }];
        this.showBulkUpload = true;
        this.msg.add({
          severity: 'error',
          summary: 'No se pudieron cargar los pagos',
          detail: message,
        });
        this.importingMovements = false;
        this.showMovementLoading = false;
      },
      complete: () => {
        this.importingMovements = false;
        this.showMovementLoading = false;
      },
    });
  }

  private async processBulkQueue() {
    const periodId = this.period?.id;
    if (this.bulkProcessing || !periodId) return;
    this.bulkProcessing = true;
    try {
      for (const receipt of this.bulkReceipts) {
        if (receipt.status !== 'queued') continue;
        receipt.status = 'scanning';
        try {
          await this.scanReceipt(receipt, periodId);
        } catch (err: any) {
          receipt.status = 'error';
          receipt.error = err.error?.message || 'No se pudo leer el comprobante.';
        }
      }
    } finally {
      this.bulkProcessing = false;
    }
  }

  private async scanReceipt(receipt: BulkReceipt, periodId: string) {
    const scan = await firstValueFrom(this.svc.scanPaymentProof(receipt.file, periodId));
    receipt.scan = scan;
    receipt.match = scan.matches.length === 1 ? scan.matches[0] : undefined;
    receipt.suggestedByAmount = false;
    if (!receipt.match && scan.suggestedMatches?.length === 1) {
      receipt.match = scan.suggestedMatches[0];
      receipt.suggestedByAmount = true;
    }
    receipt.amount = this.readOcrAmount(scan.extractedData.amount);
    receipt.paymentDate = this.toIsoDate(scan.extractedData.date);
    receipt.error = undefined;
    receipt.showManualAssignment = false;
    receipt.manualPeriodId = undefined;
    receipt.manualPeriod = undefined;
    receipt.manualPaymentId = undefined;
    receipt.manualMatch = undefined;
    receipt.status = 'ready';
  }

  retryReceiptOcr(receipt: BulkReceipt) {
    if (receipt.status === 'scanning' || receipt.status === 'confirming' || receipt.status === 'confirmed') return;
    if (receipt.source === 'movement-pdf' || receipt.source === 'movement-row') {
      this.retryMovementImport();
      return;
    }
    const periodId = this.period?.id;
    if (!periodId) return;
    receipt.status = 'scanning';
    receipt.error = undefined;
    void this.scanReceipt(receipt, periodId).catch((err: any) => {
      receipt.status = 'error';
      receipt.error = err.error?.message || 'No se pudo leer el comprobante.';
      this.msg.add({ severity: 'error', summary: 'OCR falló', detail: receipt.error });
    });
  }

  retryMovementImport() {
    if (!this.movementPdfFile) {
      this.msg.add({ severity: 'warn', summary: 'PDF no disponible', detail: 'Vuelve a seleccionar el PDF de movimientos.' });
      return;
    }
    this.importMovementPdf(this.movementPdfFile);
  }

  removeBulkReceipt(receipt: BulkReceipt) {
    if (receipt.status === 'scanning' || receipt.status === 'confirming') return;
    const remove = () => {
      this.bulkReceipts = this.bulkReceipts.filter(item => item !== receipt);
      if (!this.bulkReceipts.some(item => item.movementProofUrl || item.movementProofPublicId)) {
        this.movementPdfFile = null;
      }
    };
    if (receipt.status === 'confirmed') {
      this.confirm.confirm({
        header: 'Quitar comprobante',
        message: 'Este pago ya fue registrado. Solo se quitará de esta lista, no se eliminará el pago ni el archivo guardado.',
        icon: 'pi pi-info-circle',
        acceptLabel: 'Quitar de la lista',
        rejectLabel: 'Cancelar',
        accept: remove,
      });
      return;
    }
    remove();
  }

  private readOcrAmount(value: unknown): number | undefined {
    const amount = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[$\s]/g, '').replace(',', '.'));
    return Number.isFinite(amount) && amount > 0 ? amount : undefined;
  }

  private toIsoDate(value: unknown): string | undefined {
    const date = String(value || '').trim();
    const slash = date.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  }

  isReceiptDateInPeriod(receipt: BulkReceipt): boolean {
    const period = receipt.manualPeriod || this.period;
    return !!period && !!receipt.paymentDate &&
      receipt.paymentDate.slice(0, 7) === `${period.year}-${String(period.month).padStart(2, '0')}`;
  }

  canConfirmReceipt(receipt: BulkReceipt): boolean {
    const match = this.receiptMatch(receipt);
    return !!match && match.paymentStatus !== 'PAID' && !!receipt.amount &&
      receipt.status === 'ready' && this.receiptPaymentAmountAllowed(receipt);
  }

  receiptMatch(receipt: BulkReceipt): OcrOwnerMatch | undefined {
    return receipt.manualMatch || receipt.match;
  }

  receiptTargetPeriod(receipt: BulkReceipt): CondoExpensePeriod | null {
    return receipt.manualPeriod || this.period;
  }

  receiptTitle(receipt: BulkReceipt): string {
    if (receipt.source === 'movement-pdf') return 'PDF de movimientos';
    if (receipt.source === 'movement-row') return `Movimiento: ${receipt.description || 'Ingreso detectado'}`;
    return receipt.file.name;
  }

  receiptSubtitle(receipt: BulkReceipt): string {
    if (receipt.source === 'movement-pdf') return receipt.file.name;
    if (receipt.source === 'movement-row') {
      const amount = Number(receipt.amount || 0).toFixed(2);
      return `${receipt.paymentDate || 'Sin fecha'} · $${amount}`;
    }
    return `${(receipt.file.size / 1024).toFixed(1)} KB`;
  }

  canPreviewReceipt(receipt: BulkReceipt): boolean {
    return !!receipt.file || !!receipt.movementProofUrl;
  }

  receiptReadDate(receipt: BulkReceipt): string {
    return receipt.paymentDate || String(receipt.scan?.extractedData?.date || '');
  }

  pendingAmount(receipt: BulkReceipt): number {
    const match = this.receiptMatch(receipt);
    return match ? Math.max(0, match.totalDue - match.amountPaid) : 0;
  }

  receiptPayment(receipt: BulkReceipt): AliquotPayment | undefined {
    const match = this.receiptMatch(receipt);
    const targetPeriod = this.receiptTargetPeriod(receipt);
    return match ? targetPeriod?.payments?.find(payment => payment.id === match.paymentId) : undefined;
  }

  receiptOwnerMoraAvailable(receipt: BulkReceipt): number {
    return Number(this.receiptPayment(receipt)?.owner?.moraAmount || 0);
  }

  receiptEnteredPaymentAmount(receipt: BulkReceipt): number {
    return Number(receipt.amount || 0);
  }

  receiptMoraToApply(receipt: BulkReceipt): number {
    return Math.min(this.receiptEnteredPaymentAmount(receipt), this.receiptOwnerMoraAvailable(receipt));
  }

  receiptFinalMoraAfterPayment(receipt: BulkReceipt): number {
    return Math.max(0, this.receiptOwnerMoraAvailable(receipt) - this.receiptMoraToApply(receipt));
  }

  receiptTargetPeriodClosed(receipt: BulkReceipt): boolean {
    return this.receiptTargetPeriod(receipt)?.status === 'CLOSED';
  }

  receiptAmountForCurrentPeriod(receipt: BulkReceipt): number {
    if (this.receiptTargetPeriodClosed(receipt)) return 0;
    return Math.min(
      Math.max(0, this.receiptEnteredPaymentAmount(receipt) - this.receiptMoraToApply(receipt)),
      this.pendingAmount(receipt)
    );
  }

  receiptHasMoraPriority(receipt: BulkReceipt): boolean {
    return this.receiptOwnerMoraAvailable(receipt) > 0;
  }

  receiptPaymentAmountAllowed(receipt: BulkReceipt): boolean {
    const maxAllowed = this.receiptTargetPeriodClosed(receipt)
      ? this.receiptOwnerMoraAvailable(receipt)
      : this.pendingAmount(receipt) + this.receiptOwnerMoraAvailable(receipt);
    return this.receiptEnteredPaymentAmount(receipt) <= maxAllowed + 0.01;
  }

  periodLabel(period: CondoExpensePeriod): string {
    return `${MONTHS[period.month - 1]} ${period.year}`;
  }

  get manualPeriodOptions() {
    const periods = [
      ...(this.period && this.period.status !== 'CLOSED' ? [this.period] : []),
      ...this.manualPeriods,
    ];
    const uniquePeriods = periods.filter((period, index, list) =>
      !!period && list.findIndex(item => item.id === period.id) === index
    );
    return uniquePeriods.map(period => ({
      id: period.id,
      label: this.periodLabel(period),
      month: period.month,
      year: period.year,
    }));
  }

  manualPaymentOptions(receipt: BulkReceipt) {
    return [...(receipt.manualPeriod?.payments || [])]
      .sort((first, second) =>
        String(first.owner?.apartmentNumber || '').localeCompare(
          String(second.owner?.apartmentNumber || ''),
          'es',
          { numeric: true, sensitivity: 'base' },
        ),
      )
      .map(payment => ({
        id: payment.id,
        label: `${payment.owner?.apartmentNumber || '—'} — ${payment.owner?.fullName || 'Propietario'}`,
        apartmentNumber: payment.owner?.apartmentNumber || '',
        fullName: payment.owner?.fullName || '',
        disabled: payment.status === 'PAID',
      }));
  }

  openManualAssignment(receipt: BulkReceipt) {
    receipt.showManualAssignment = true;
    if (receipt.status === 'error') receipt.status = 'ready';
    this.selectCurrentPeriodForReceipt(receipt);
    if (this.manualPeriods.length || this.loadingManualPeriods) return;
    this.loadingManualPeriods = true;
    this.svc.getPeriods().subscribe({
      next: periods => { this.manualPeriods = periods.filter(p => p.status !== 'CLOSED'); this.loadingManualPeriods = false; },
      error: () => { this.loadingManualPeriods = false; receipt.error = 'No se pudieron cargar los períodos.'; },
    });
  }

  private selectCurrentPeriodForReceipt(receipt: BulkReceipt) {
    if (!this.period || receipt.manualPeriodId) return;
    receipt.manualPeriodId = this.period.id;
    receipt.manualPeriod = this.period;
    receipt.manualPaymentId = undefined;
    receipt.manualMatch = undefined;
  }

  onManualPeriodSelected(receipt: BulkReceipt) {
    receipt.manualPaymentId = undefined;
    receipt.manualMatch = undefined;
    receipt.manualPeriod = undefined;
    if (!receipt.manualPeriodId) return;
    if (receipt.manualPeriodId === this.period?.id) {
      receipt.manualPeriod = this.period;
      return;
    }
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
      owner: { id: payment.ownerId, fullName: payment.owner?.fullName || 'Propietario', apartmentNumber: payment.owner?.apartmentNumber || '—' },
    };
  }

  ocrConfidence(receipt: BulkReceipt): number | null {
    const confidence = receipt.scan?.extractedData.confidence_score;
    return typeof confidence === 'number' ? confidence : null;
  }

  confirmReceipt(receipt: BulkReceipt) {
    const match = this.receiptMatch(receipt);
    const targetPeriod = receipt.manualPeriod || this.period;
    if (!targetPeriod || !match || !this.canConfirmReceipt(receipt)) return;
    this.confirm.confirm({
      header: 'Confirmar pago detectado',
      message: `Se registrará $${receipt.amount!.toFixed(2)} en la alícuota de ${MONTHS[targetPeriod.month - 1]} ${targetPeriod.year}, departamento ${match.owner.apartmentNumber}, con fecha ${receipt.paymentDate}. Verifica que corresponde a este mes antes de continuar.`,
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
    const hasMovementProof = !!receipt.movementProofUrl && !!receipt.movementProofPublicId;
    this.svc.confirmOcrPayment(match.paymentId, hasMovementProof ? null : receipt.file, {
      amount: receipt.amount,
      paymentDate: receipt.paymentDate,
      ocrSenderName: receipt.scan?.extractedData.sender_name,
      ocrBank: receipt.scan?.extractedData.bank,
      movementProofUrl: receipt.movementProofUrl,
      movementProofPublicId: receipt.movementProofPublicId,
    }).subscribe({
      next: () => {
        receipt.status = 'confirmed';
        this.loadPeriod(this.period!.id);
        this.msg.add({ severity: 'success', summary: 'Pago registrado', detail: `Departamento ${match.owner.apartmentNumber}` });
      },
      error: err => {
        receipt.status = 'ready';
        receipt.error = err.error?.message || 'No se pudo guardar el pago.';
        this.msg.add({ severity: 'error', summary: 'No se registró el pago', detail: receipt.error });
      },
    });
  }

  // ── Payment ──────────────────────────────────────────────
  openPaymentDialog(payment: AliquotPayment) {
    this.selectedPayment = payment;
    this.selectedFile = null;
    this.paymentForm.reset({
      paymentMonth: this.period ? `${this.period.year}-${String(this.period.month).padStart(2, '0')}` : '',
    });
    this.showPaymentDialog = true;
  }

  registerPayment() {
    if (!this.selectedPayment || this.paymentForm.invalid || !this.selectedFile || !this.paymentAmountAllowed) return;
    this.saving = true;
    const { amountPaid, paymentDate, paymentMonth, notes } = this.paymentForm.value;
    const dateStr = paymentDate instanceof Date
      ? paymentDate.toISOString().split('T')[0]
      : String(paymentDate);

    const proof = this.selectedFile;
    this.svc.registerPayment(this.selectedPayment.id, {
      amountPaid: amountPaid!,
      paymentDate: dateStr,
      paymentMonth: paymentMonth!,
      notes: notes ?? undefined,
    }).subscribe({
      next: (payment) => {
        this.uploadingProof = true;
        this.svc.uploadProof(payment.id, proof, payment.moraPaymentRecordIds, payment.paymentRecordId).subscribe({
          next: () => this.finishPaymentRegistration(true),
          error: (err) => {
            this.saving = false;
            this.uploadingProof = false;
            this.showPaymentDialog = false;
            this.selectedFile = null;
            this.loadPeriod(this.period!.id);
            this.msg.add({
              severity: 'warn', summary: 'Pago registrado',
              detail: err.error?.message || 'El comprobante no pudo subirse.',
            });
          },
        });
      },
      error: (err) => { this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }); this.saving = false; },
    });
  }

  private finishPaymentRegistration(withProof: boolean) {
    this.msg.add({
      severity: 'success', summary: 'Pago registrado',
      detail: withProof ? 'Comprobante subido correctamente.' : '',
    });
    this.showPaymentDialog = false;
    this.saving = false;
    this.uploadingProof = false;
    this.selectedFile = null;
    this.loadPeriod(this.period!.id);
  }

  // ── Proof Upload ─────────────────────────────────────────
  openProofPreview(payment: AliquotPayment) {
    if (!payment.proofUrl) return;
    this.selectedPayment = payment;
    this.openProofPreviewUrl(payment.proofUrl);
  }

  openProofPreviewUrl(url: string) {
    this.revokeProofPreviewObjectUrl();
    this.proofPreviewUrl = url;
    this.proofPreviewIsPdf = this.isPdfUrl(url);
    this.proofPreviewResource = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    this.showProofPreview = true;
  }

  openBulkReceiptPreview(receipt: BulkReceipt) {
    if (receipt.movementProofUrl) {
      this.openProofPreviewUrl(receipt.movementProofUrl);
      return;
    }
    if (!receipt.file) return;
    this.revokeProofPreviewObjectUrl();
    const url = URL.createObjectURL(receipt.file);
    this.proofPreviewObjectUrl = url;
    this.proofPreviewUrl = url;
    this.proofPreviewIsPdf = this.fileLooksPdf(receipt.file);
    this.proofPreviewResource = this.proofPreviewIsPdf
      ? this.sanitizer.bypassSecurityTrustResourceUrl(url)
      : null;
    this.showProofPreview = true;
  }

  clearProofPreview() {
    this.revokeProofPreviewObjectUrl();
    this.proofPreviewUrl = '';
    this.proofPreviewResource = null;
    this.proofPreviewIsPdf = false;
  }

  openMoraProofs(payment: AliquotPayment) {
    const proofs = payment.moraPaymentProofs || [];
    if (proofs.length === 1 && proofs[0].proofUrl) {
      this.openProofPreviewUrl(proofs[0].proofUrl);
      return;
    }
    this.selectedMoraProofPayment = payment;
    this.showMoraProofsDialog = true;
  }

  openPaymentRecords(payment: AliquotPayment) {
    this.selectedPaymentRecordsPayment = payment;
    this.showPaymentRecordsDialog = true;
  }

  paymentRecordLabel(record: AliquotPaymentRecord): string {
    return record.sourceType === 'OCR' ? 'OCR' :
      record.sourceType === 'PROOF' ? 'Comprobante' : 'Manual';
  }

  pendingProofRecordId(payment: AliquotPayment | null): string | undefined {
    return payment?.paymentRecords?.find(record => !record.proofUrl)?.id;
  }

  isPdfProof(): boolean {
    return this.proofPreviewIsPdf || this.isPdfUrl(this.proofPreviewUrl);
  }

  private isPdfUrl(url: string): boolean {
    return /\.pdf(?:$|[?#])/i.test(url) || /\/raw\/upload\//i.test(url);
  }

  private fileLooksPdf(file: File): boolean {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  }

  private revokeProofPreviewObjectUrl() {
    if (!this.proofPreviewObjectUrl) return;
    URL.revokeObjectURL(this.proofPreviewObjectUrl);
    this.proofPreviewObjectUrl = null;
  }

  openProofDialog(payment: AliquotPayment) {
    this.selectedPayment = payment;
    this.selectedFile = null;
    this.showProofDialog = true;
  }

  onFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files?.[0]) this.selectedFile = input.files[0];
  }

  onDragOver(event: DragEvent) { event.preventDefault(); }
  onDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) this.selectedFile = file;
  }

  clearFile() { this.selectedFile = null; }

  uploadProof() {
    if (!this.selectedPayment || !this.selectedFile) return;
    this.uploadingProof = true;
    this.svc.uploadProof(this.selectedPayment.id, this.selectedFile, undefined, this.pendingProofRecordId(this.selectedPayment)).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Comprobante subido', detail: 'Estado actualizado automáticamente' });
        this.showProofDialog = false;
        this.uploadingProof = false;
        this.selectedFile = null;
        this.loadPeriod(this.period!.id);
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error al subir', detail: err.error?.message || 'Intenta de nuevo' });
        this.uploadingProof = false;
      },
    });
  }

  deleteProof() {
    if (!this.selectedPayment) return;
    this.deletingProof = true;
    this.svc.deleteProof(this.selectedPayment.id).subscribe({
      next: () => {
        this.msg.add({ severity: 'info', summary: 'Comprobante eliminado', detail: '' });
        this.showProofDialog = false;
        this.deletingProof = false;
        this.loadPeriod(this.period!.id);
      },
      error: () => this.deletingProof = false,
    });
  }

  // ── Extra charge ─────────────────────────────────────────
  openExtraDialog(payment: AliquotPayment) {
    this.selectedPayment  = payment;
    this.editingExtra     = null;
    this.newExtraAmount   = null;
    this.newExtraNotes    = '';
    this.showExtraDialog  = true;
  }

  addExtra() {
    const amount = Number(this.newExtraAmount || 0);
    if (!this.selectedPayment || !this.canManageExtras || amount <= 0 || !this.newExtraNotes.trim()) return;
    this.savingExtra = true;
    this.svc.addPaymentExtra(this.selectedPayment.id, amount, this.newExtraNotes.trim()).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Cargo extra agregado' });
        this.newExtraAmount = null; this.newExtraNotes = '';
        this.savingExtra = false;
        this.loadPeriod(this.period!.id);
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.savingExtra = false;
      },
    });
  }

  startEditExtra(extra: PaymentExtra) {
    if (!this.canManageExtras) return;
    this.editingExtra     = extra;
    this.editExtraAmount  = extra.amount;
    this.editExtraNotes   = extra.notes;
  }

  cancelEditExtra() { this.editingExtra = null; }

  saveEditExtra() {
    if (!this.canManageExtras || !this.editingExtra || this.editExtraAmount <= 0 || !this.editExtraNotes.trim()) return;
    this.savingExtra = true;
    this.svc.updatePaymentExtra(this.editingExtra.id, this.editExtraAmount, this.editExtraNotes.trim()).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Cargo extra actualizado' });
        this.editingExtra = null; this.savingExtra = false;
        this.loadPeriod(this.period!.id);
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.savingExtra = false;
      },
    });
  }

  deleteExtra(extra: PaymentExtra) {
    if (!this.canManageExtras) return;
    this.deletingExtra = extra.id;
    this.svc.deletePaymentExtra(extra.id).subscribe({
      next: () => {
        this.msg.add({ severity: 'info', summary: 'Cargo extra eliminado' });
        this.deletingExtra = null;
        // Actualizar en memoria para evitar reload completo
        if (this.selectedPayment) {
          this.selectedPayment = {
            ...this.selectedPayment,
            extras: this.selectedPayment.extras.filter(e => e.id !== extra.id),
          };
          this.loadPeriod(this.period!.id);
        }
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.deletingExtra = null;
      },
    });
  }

  downloadPdf(payment: AliquotPayment) {
    this.svc.downloadPaymentPdf(payment.id).subscribe(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `alicuota-depto${payment.owner?.apartmentNumber}.pdf`;
      a.click(); URL.revokeObjectURL(url);
    });
  }

  // ── Helpers ──────────────────────────────────────────────
  statusSeverity(s: string): TagSeverity {
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

  paymentStatusLabel(s: PaymentStatus): string {
    const map: Record<PaymentStatus, string> = { PENDING: 'Pendiente', PARTIAL: 'Parcial', PAID: 'Pagado', OVERDUE: 'En mora' };
    return map[s];
  }

  expenseCategoryLabel(category: string): string {
    return EXPENSE_CATEGORY_LABELS[category] || category;
  }

  paymentStatusSeverity(s: PaymentStatus): TagSeverity {
    const map: Record<PaymentStatus, TagSeverity> = { PENDING: 'warning', PARTIAL: 'info', PAID: 'success', OVERDUE: 'danger' };
    return map[s];
  }
}
