import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { firstValueFrom, forkJoin } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { CalendarModule } from 'primeng/calendar';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { FileUploadModule } from 'primeng/fileupload';
import { ImageModule } from 'primeng/image';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { MessageService, ConfirmationService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { AliquotPayment, CondoExpensePeriod, CondoPeriodExpenseItem, OcrOwnerMatch, OcrScanResult, PaymentExtra, PaymentStatus } from '../../../shared/models/models';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;
type BulkReceiptStatus = 'queued' | 'scanning' | 'ready' | 'error' | 'confirming' | 'confirmed';

interface BulkReceipt {
  id?: string;
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
  description?: string;
  suggestedByAmount?: boolean;
  movementProofUrl?: string;
  movementProofPublicId?: string;
}

@Component({
  selector: 'app-condo-period-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, RouterModule,
    TableModule, ButtonModule, DialogModule, InputTextModule, InputNumberModule,
    CalendarModule, TagModule, TooltipModule, ToastModule, ConfirmDialogModule,
    FileUploadModule, ImageModule, InputTextareaModule],
  providers: [MessageService, ConfirmationService],
  templateUrl: './condo-period-detail.component.html',
  styleUrl: './condo-period-detail.component.css',
})
export class CondoPeriodDetailComponent implements OnInit {
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

  showPaymentDialog = false;
  showProofDialog   = false;
  showExtraDialog   = false;
  showBulkUpload    = false;
  showProofPreview  = false;
  showMoraProofsDialog = false;
  selectedPayment: AliquotPayment | null = null;
  selectedMoraProofPayment: AliquotPayment | null = null;
  selectedFile: File | null = null;
  proofPreviewUrl = '';
  proofPreviewResource: SafeResourceUrl | null = null;
  bulkProcessing = false;
  importingMovements = false;
  showMovementLoading = false;
  bulkReceipts: BulkReceipt[] = [];
  manualPeriods: CondoExpensePeriod[] = [];
  loadingManualPeriods = false;

  // ── Extras ─────────────────────────────────────────────
  savingExtra   = false;
  deletingExtra: string | null = null;  // ID del extra que se está borrando
  editingExtra:  PaymentExtra | null = null;
  newExtraAmount = 0;
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

  get amountForCurrentPeriod(): number {
    return this.selectedPayment
      ? Math.min(Math.max(0, this.enteredPaymentAmount - this.moraToApply), this.periodPending(this.selectedPayment))
      : 0;
  }

  get hasMoraPriority(): boolean {
    return this.ownerMoraAvailable > 0;
  }

  get paymentAmountAllowed(): boolean {
    return !!this.selectedPayment &&
      this.enteredPaymentAmount <= this.periodPending(this.selectedPayment) + this.ownerMoraAvailable + 0.01;
  }

  ngOnInit() {
    this.route.params.subscribe(p => this.loadPeriod(p['id']));
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

  generate() {
    if (!this.period) return;
    this.generating = true;
    const id = this.period.id;
    this.svc.generateAliquots(id).subscribe({
      next: () => {
        this.generating = false;
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
      next: (r) => { this.msg.add({ severity: 'success', summary: `${(r as any).sent} correos enviados`, detail: '' }); this.sending = false; },
      error: () => this.sending = false,
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
    this.bulkReceipts.push(...files.map(file => ({ file, status: 'queued' as const })));
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

    this.importingMovements = true;
    this.showMovementLoading = true;
    // Un estado de cuenta representa una nueva fuente de movimientos. No se
    // deben conservar filas del PDF importado anteriormente en la vista.
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
        this.msg.add({
          severity: 'error',
          summary: 'No se pudieron cargar los pagos',
          detail: err.error?.message || 'Intenta nuevamente con el PDF de movimientos.',
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
          const scan = await firstValueFrom(this.svc.scanPaymentProof(receipt.file, periodId));
          receipt.scan = scan;
          receipt.match = scan.matches.length === 1 ? scan.matches[0] : undefined;
          if (!receipt.match && scan.suggestedMatches?.length === 1) {
            receipt.match = scan.suggestedMatches[0];
            receipt.suggestedByAmount = true;
          }
          receipt.amount = this.readOcrAmount(scan.extractedData.amount);
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
      receipt.status === 'ready';
  }

  receiptMatch(receipt: BulkReceipt): OcrOwnerMatch | undefined {
    return receipt.manualMatch || receipt.match;
  }

  receiptTargetPeriod(receipt: BulkReceipt): CondoExpensePeriod | null {
    return receipt.manualPeriod || this.period;
  }

  pendingAmount(receipt: BulkReceipt): number {
    const match = this.receiptMatch(receipt);
    return match ? Math.max(0, match.totalDue - match.amountPaid) : 0;
  }

  periodLabel(period: CondoExpensePeriod): string {
    return `${MONTHS[period.month - 1]} ${period.year}`;
  }

  openManualAssignment(receipt: BulkReceipt) {
    receipt.showManualAssignment = true;
    if (receipt.status === 'error') receipt.status = 'ready';
    if (this.manualPeriods.length || this.loadingManualPeriods) return;
    this.loadingManualPeriods = true;
    this.svc.getPeriods().subscribe({
      next: periods => { this.manualPeriods = periods.filter(p => p.status !== 'CLOSED'); this.loadingManualPeriods = false; },
      error: () => { this.loadingManualPeriods = false; receipt.error = 'No se pudieron cargar los períodos.'; },
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
        this.svc.uploadProof(payment.id, proof, payment.moraPaymentRecordIds).subscribe({
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
    this.proofPreviewUrl = url;
    this.proofPreviewResource = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    this.showProofPreview = true;
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

  isPdfProof(): boolean {
    return /\.pdf(?:$|[?#])/i.test(this.proofPreviewUrl) || /\/raw\/upload\//i.test(this.proofPreviewUrl);
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
    this.svc.uploadProof(this.selectedPayment.id, this.selectedFile).subscribe({
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
    this.newExtraAmount   = 0;
    this.newExtraNotes    = '';
    this.showExtraDialog  = true;
  }

  addExtra() {
    if (!this.selectedPayment || this.newExtraAmount <= 0 || !this.newExtraNotes.trim()) return;
    this.savingExtra = true;
    this.svc.addPaymentExtra(this.selectedPayment.id, this.newExtraAmount, this.newExtraNotes.trim()).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Cargo extra agregado' });
        this.newExtraAmount = 0; this.newExtraNotes = '';
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
    this.editingExtra     = extra;
    this.editExtraAmount  = extra.amount;
    this.editExtraNotes   = extra.notes;
  }

  cancelEditExtra() { this.editingExtra = null; }

  saveEditExtra() {
    if (!this.editingExtra || this.editExtraAmount <= 0 || !this.editExtraNotes.trim()) return;
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
  paymentStatusSeverity(s: PaymentStatus): TagSeverity {
    const map: Record<PaymentStatus, TagSeverity> = { PENDING: 'warning', PARTIAL: 'info', PAID: 'success', OVERDUE: 'danger' };
    return map[s];
  }
}
