import { Component, ElementRef, inject, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { DropdownModule } from 'primeng/dropdown';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoOwner, CondoOwnerPaymentHistoryReport, CondoOwnerPaymentHistoryRow } from '../../../shared/models/models';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const EMPTY_HISTORY_REPORT: CondoOwnerPaymentHistoryReport = {
  rows: [],
  summary: {
    totalCharged: 0,
    totalPaid: 0,
    totalPending: 0,
    totalAppliedToMora: 0,
    currentMora: 0,
  },
};

@Component({
  selector: 'app-condo-owners',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, TableModule, ButtonModule, DialogModule,
    InputTextModule, InputNumberModule, TagModule, TooltipModule, DropdownModule, ToastModule],
  providers: [MessageService],
  templateUrl: './condo-owners.component.html',
  styleUrl: './condo-owners.component.css',
})
export class CondoOwnersComponent implements OnInit {
  private svc = inject(CondominiumService);
  private fb = inject(FormBuilder);
  private msg = inject(MessageService);

  owners: CondoOwner[] = [];
  totalPct = 0;
  loading = false;
  saving = false;
  importing = false;

  showDialog = false;
  showMoraDialog = false;
  showImportResult = false;
  showHistoryReport = false;
  loadingHistoryReport = false;
  editingOwner: CondoOwner | null = null;
  moraOwner: CondoOwner | null = null;
  moraOperation: 'ADD' | 'SUBTRACT' | 'SET' = 'SUBTRACT';
  moraAmount = 0;
  importResult: { inserted: number; updated: number; errors: { row: number; unit: string; reason: string }[] } | null = null;
  historyReport: CondoOwnerPaymentHistoryReport = EMPTY_HISTORY_REPORT;
  historyOwnerId = '';
  historyDateFrom = '';
  historyDateTo = '';

  form = this.fb.group({
    apartmentNumber: ['', Validators.required],
    fullName: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    phone: [''],
    participationPct: [null as number | null, [Validators.required, Validators.min(0.01), Validators.max(100)]],
  });

  get historyOwnerOptions() {
    return [
      { id: '', label: 'Todos los propietarios', apartmentNumber: '', fullName: 'Todos los propietarios' },
      ...this.owners.map(owner => ({
        id: owner.id,
        label: `Depto. ${owner.apartmentNumber} - ${owner.fullName}`,
        apartmentNumber: owner.apartmentNumber,
        fullName: owner.fullName,
      })),
    ];
  }

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    this.svc.getOwners().subscribe({
      next: (res) => {
        this.owners = [...res.owners].sort((first, second) =>
          first.apartmentNumber.localeCompare(second.apartmentNumber, 'es', {
            numeric: true,
            sensitivity: 'base',
          }),
        );
        this.totalPct = res.totalParticipationPct;
        this.loading = false;
      },
      error: () => this.loading = false,
    });
  }

  onImportFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.importing = true;
    this.svc.importOwners(file).subscribe({
      next: (res: any) => {
        const data = res.data ?? res;
        this.importResult = data;
        this.importing = false;
        this.showImportResult = true;
        input.value = ''; // permite volver a seleccionar el mismo archivo
        this.load();
      },
      error: (err: any) => {
        this.msg.add({ severity: 'error', summary: 'Error al importar', detail: err.error?.message || 'Error inesperado' });
        this.importing = false;
        input.value = '';
      },
    });
  }

  openDialog(owner?: CondoOwner) {
    this.editingOwner = owner ?? null;
    this.form.reset();
    if (owner) this.form.patchValue(owner as any);
    this.showDialog = true;
  }

  save() {
    if (this.form.invalid) return;
    this.saving = true;
    const data = this.form.value as any;
    const obs = this.editingOwner
      ? this.svc.updateOwner(this.editingOwner.id, data)
      : this.svc.createOwner(data);

    obs.subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Éxito', detail: this.editingOwner ? 'Actualizado' : 'Co-propietario creado' });
        this.showDialog = false;
        this.saving = false;
        this.load();
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message || 'Error al guardar' });
        this.saving = false;
      },
    });
  }

  toggleOwner(owner: CondoOwner) {
    this.svc.toggleOwner(owner.id).subscribe({
      next: () => {
        this.msg.add({ severity: 'info', summary: 'Estado actualizado', detail: '' });
        this.load();
      },
    });
  }

  openMoraDialog(owner: CondoOwner) {
    this.moraOwner = owner;
    this.moraAmount = 0;
    this.moraOperation = 'SUBTRACT';
    this.showMoraDialog = true;
  }

  applyMora() {
    if (!this.moraOwner) return;
    this.saving = true;
    this.svc.adjustMora(this.moraOwner.id, this.moraAmount, this.moraOperation).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Mora actualizada', detail: '' });
        this.showMoraDialog = false;
        this.saving = false;
        this.load();
      },
      error: () => this.saving = false,
    });
  }

  openHistoryReport() {
    this.showHistoryReport = true;
    this.loadHistoryReport();
  }

  loadHistoryReport() {
    this.loadingHistoryReport = true;
    this.svc.getOwnerPaymentHistoryReport({
      ownerId: this.historyOwnerId || undefined,
      dateFrom: this.historyDateFrom || undefined,
      dateTo: this.historyDateTo || undefined,
    }).subscribe({
      next: (report) => {
        this.historyReport = report;
        this.loadingHistoryReport = false;
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'No se generó el reporte', detail: err.error?.message || 'Intenta nuevamente' });
        this.loadingHistoryReport = false;
      },
    });
  }

  downloadHistoryCsv() {
    const rows = this.historyReport.rows;
    if (!rows.length) return;
    const headers = [
      'Fecha', 'Departamento', 'Propietario', 'Concepto', 'Periodo', 'Estado',
      'Movimiento', 'Cargo', 'Pago total', 'Aplicado al periodo', 'Aplicado a mora',
      'Pendiente/Mora', 'Notas', 'Comprobante',
    ];
    const csvRows = rows.map(row => [
      this.formatDate(row.movementDate),
      row.apartmentNumber,
      row.ownerName,
      this.historyConceptLabel(row),
      this.historyPeriodLabel(row),
      row.status ? this.paymentStatusLabel(row.status) : '',
      this.signedMoneyValue(row),
      this.moneyValue(row.chargedAmount),
      this.moneyValue(row.paidAmount),
      this.moneyValue(row.amountForPeriod),
      this.moneyValue(row.amountForMora || row.moraPaymentAmount),
      this.moneyValue(row.pendingAmount),
      row.notes || '',
      row.proofUrl || '',
    ]);
    const csv = [headers, ...csvRows]
      .map(row => row.map(value => this.csvCell(value)).join(','))
      .join('\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `historial-pagos-moras-${this.historyOwnerId ? this.selectedHistoryOwnerLabel() : 'todos'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  historyMovementLabel(type: CondoOwnerPaymentHistoryRow['movementType']): string {
    const labels: Record<CondoOwnerPaymentHistoryRow['movementType'], string> = {
      ALIQUOT_CHARGE: 'Alícuota emitida',
      PAYMENT: 'Pago registrado',
      DIRECT_MORA_PAYMENT: 'Abono directo a mora',
      OVERDUE_BALANCE: 'Alícuota emitida en mora',
    };
    return labels[type] ?? type;
  }

  historyConceptLabel(row: CondoOwnerPaymentHistoryRow): string {
    if (row.movementType === 'ALIQUOT_CHARGE' && row.status === 'OVERDUE') {
      return 'Alícuota emitida en mora';
    }
    return this.historyMovementLabel(row.movementType);
  }

  historyMovementHint(row: CondoOwnerPaymentHistoryRow): string {
    if (row.movementType === 'ALIQUOT_CHARGE' && row.status === 'OVERDUE') {
      return `Saldo acumulado pendiente después del cargo: ${this.currencyText(row.pendingAmount)}.`;
    }
    if (row.movementType === 'PAYMENT' && row.amountForMora > 0 && row.amountForPeriod > 0) return 'Pago dividido entre mora y período.';
    if (row.movementType === 'PAYMENT' && row.amountForMora > 0) return 'Pago aplicado a mora acumulada.';
    if (row.movementType === 'PAYMENT') return 'Pago aplicado al período.';
    if (row.movementType === 'DIRECT_MORA_PAYMENT') return 'Abono registrado directamente contra mora.';
    return 'Cargo mensual emitido al propietario.';
  }

  historyMovementSeverity(row: CondoOwnerPaymentHistoryRow): 'info' | 'success' | 'warning' | 'danger' {
    if (row.movementType === 'PAYMENT' || row.movementType === 'DIRECT_MORA_PAYMENT') return 'success';
    if (row.movementType === 'OVERDUE_BALANCE' || (row.movementType === 'ALIQUOT_CHARGE' && row.status === 'OVERDUE')) return 'warning';
    return 'info';
  }

  historySignedAmount(row: CondoOwnerPaymentHistoryRow): number {
    if (row.movementType === 'ALIQUOT_CHARGE') {
      return -Number(row.chargedAmount || 0);
    }
    if (row.movementType === 'OVERDUE_BALANCE') return -Number(row.pendingAmount || 0);
    return Number(row.paidAmount || 0);
  }

  signedMoney(row: CondoOwnerPaymentHistoryRow): string {
    const amount = this.historySignedAmount(row);
    const abs = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${amount >= 0 ? '+' : '-'}$${abs}`;
  }

  signedMoneyValue(row: CondoOwnerPaymentHistoryRow): string {
    return this.historySignedAmount(row).toFixed(2);
  }

  historyAmountClass(row: CondoOwnerPaymentHistoryRow): string {
    return this.historySignedAmount(row) >= 0 ? 'statement-credit' : 'statement-debit';
  }

  historyRowClass(row: CondoOwnerPaymentHistoryRow): string {
    if (row.movementType === 'OVERDUE_BALANCE' || (row.movementType === 'ALIQUOT_CHARGE' && row.status === 'OVERDUE')) {
      return 'statement-row-overdue';
    }
    if (row.movementType === 'PAYMENT' || row.movementType === 'DIRECT_MORA_PAYMENT') return 'statement-row-credit';
    return 'statement-row-debit';
  }

  historyPeriodLabel(row: CondoOwnerPaymentHistoryRow): string {
    return row.month && row.year ? `${MONTHS[row.month - 1]} ${row.year}` : '—';
  }

  paymentStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      PENDING: 'Pendiente',
      PARTIAL: 'Parcial',
      PAID: 'Pagado',
      OVERDUE: 'Vencido',
    };
    return labels[status] ?? status;
  }

  selectedHistoryOwnerLabel(): string {
    const owner = this.owners.find(o => o.id === this.historyOwnerId);
    return owner ? `depto-${owner.apartmentNumber}` : 'todos';
  }

  private moneyValue(value: number | null | undefined): string {
    return Number(value || 0).toFixed(2);
  }

  private currencyText(value: number | null | undefined): string {
    return `$${Math.abs(Number(value || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  private formatDate(value: string): string {
    const [date] = String(value || '').split('T');
    const parts = date.split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : date;
  }

  private csvCell(value: unknown): string {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }
}
