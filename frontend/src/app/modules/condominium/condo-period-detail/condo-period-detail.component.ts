import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
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
import { AliquotPayment, CondoExpensePeriod, CondoPeriodExpenseItem, PaymentExtra, PaymentStatus } from '../../../shared/models/models';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;

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

  period: CondoExpensePeriod | null = null;
  expenseItems: CondoPeriodExpenseItem[] = [];
  loading = false; generating = false; sending = false;
  saving = false; uploadingProof = false; deletingProof = false;

  showPaymentDialog = false;
  showProofDialog   = false;
  showExtraDialog   = false;
  selectedPayment: AliquotPayment | null = null;
  selectedFile: File | null = null;

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
        this.period       = period;
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
    this.svc.closePeriod(this.period.id).subscribe({
      next: () => { this.msg.add({ severity: 'info', summary: 'Período cerrado', detail: '' }); this.loadPeriod(this.period!.id); },
    });
  }

  // ── Payment ──────────────────────────────────────────────
  openPaymentDialog(payment: AliquotPayment) {
    this.selectedPayment = payment;
    this.paymentForm.reset();
    this.showPaymentDialog = true;
  }

  registerPayment() {
    if (!this.selectedPayment || this.paymentForm.invalid) return;
    this.saving = true;
    const { amountPaid, paymentDate, paymentMonth, notes } = this.paymentForm.value;
    const dateStr = paymentDate instanceof Date
      ? paymentDate.toISOString().split('T')[0]
      : String(paymentDate);

    this.svc.registerPayment(this.selectedPayment.id, {
      amountPaid: amountPaid!,
      paymentDate: dateStr,
      paymentMonth: paymentMonth!,
      notes: notes ?? undefined,
    }).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Pago registrado', detail: '' });
        this.showPaymentDialog = false;
        this.saving = false;
        this.loadPeriod(this.period!.id);
      },
      error: (err) => { this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }); this.saving = false; },
    });
  }

  // ── Proof Upload ─────────────────────────────────────────
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
  paymentStatusLabel(s: PaymentStatus): string {
    const map: Record<PaymentStatus, string> = { PENDING: 'Pendiente', PARTIAL: 'Parcial', PAID: 'Pagado', OVERDUE: 'En mora' };
    return map[s];
  }
  paymentStatusSeverity(s: PaymentStatus): TagSeverity {
    const map: Record<PaymentStatus, TagSeverity> = { PENDING: 'warning', PARTIAL: 'info', PAID: 'success', OVERDUE: 'danger' };
    return map[s];
  }
}
