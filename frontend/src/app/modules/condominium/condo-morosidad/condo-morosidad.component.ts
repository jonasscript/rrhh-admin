import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoOwner } from '../../../shared/models/models';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

@Component({
  selector: 'app-condo-morosidad',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, CardModule, ButtonModule,
    DialogModule, InputNumberModule, InputTextModule, ToastModule],
  providers: [MessageService],
  templateUrl: './condo-morosidad.component.html',
  styleUrl: './condo-morosidad.component.css',
})
export class CondoMorosidadComponent implements OnInit {
  private svc = inject(CondominiumService);
  private msg = inject(MessageService);
  private sanitizer = inject(DomSanitizer);
  owners: CondoOwner[] = [];
  loading = false;
  showDebtPeriods = false;
  showMoraPayment = false;
  showProofPreview = false;
  selectedOwner: CondoOwner | null = null;
  moraPaymentAmount: number | null = null;
  moraPaymentDate = new Date().toISOString().slice(0, 10);
  moraPaymentNotes = '';
  moraPaymentFile: File | null = null;
  savingMoraPayment = false;
  proofPreviewUrl = '';
  proofPreviewResource: SafeResourceUrl | null = null;

  get totalMora() { return this.owners.reduce((s, o) => s + Number(o.moraAmount), 0); }

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading = true;
    this.svc.getMorosidadReport().subscribe({
      next: (owners) => {
        this.owners = [...owners]
          .map(owner => ({
            ...owner,
            debtPeriods: [...(owner.debtPeriods || [])].sort((first, second) =>
              first.year - second.year || first.month - second.month,
            ),
            moraPayments: [...(owner.moraPayments || [])].sort((first, second) => {
              const firstPeriod = (first.debtYear ?? Number.MAX_SAFE_INTEGER) * 12 + (first.debtMonth ?? 12);
              const secondPeriod = (second.debtYear ?? Number.MAX_SAFE_INTEGER) * 12 + (second.debtMonth ?? 12);
              return firstPeriod - secondPeriod ||
                String(first.paymentDate).localeCompare(String(second.paymentDate));
            }),
          }))
          .sort((first, second) => first.apartmentNumber.localeCompare(second.apartmentNumber, 'es', {
            numeric: true,
            sensitivity: 'base',
          }));
        this.loading = false;
      },
      error: () => this.loading = false,
    });
  }

  openDebtPeriods(owner: CondoOwner) {
    this.selectedOwner = owner;
    this.showDebtPeriods = true;
  }

  openMoraPayment(owner: CondoOwner) {
    this.selectedOwner = owner;
    this.moraPaymentAmount = null;
    this.moraPaymentDate = new Date().toISOString().slice(0, 10);
    this.moraPaymentNotes = '';
    this.moraPaymentFile = null;
    this.showMoraPayment = true;
  }

  onMoraPaymentFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    this.moraPaymentFile = input.files?.[0] || null;
  }

  saveMoraPayment() {
    if (!this.selectedOwner || !this.moraPaymentFile || !this.moraPaymentAmount || this.moraPaymentAmount <= 0) return;
    if (this.moraPaymentAmount > this.selectedOwner.moraAmount + 0.01) return;
    this.savingMoraPayment = true;
    this.svc.registerMoraPayment(this.selectedOwner.id, this.moraPaymentFile, {
      amount: this.moraPaymentAmount,
      paymentDate: this.moraPaymentDate,
      notes: this.moraPaymentNotes || undefined,
    }).subscribe({
      next: () => {
        this.savingMoraPayment = false;
        this.showMoraPayment = false;
        this.msg.add({ severity: 'success', summary: 'Abono a mora registrado', detail: 'Comprobante guardado correctamente.' });
        this.load();
      },
      error: err => {
        this.savingMoraPayment = false;
        this.msg.add({ severity: 'error', summary: 'No se registró el abono', detail: err.error?.message || 'Intenta nuevamente.' });
      },
    });
  }

  openProofPreview(url: string) {
    this.proofPreviewUrl = url;
    this.proofPreviewResource = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    this.showProofPreview = true;
  }

  isPdfProof(): boolean {
    return /\.pdf(?:$|[?#])/i.test(this.proofPreviewUrl) || /\/raw\/upload\//i.test(this.proofPreviewUrl);
  }

  monthName(month: number) { return MONTHS[month - 1] || ''; }
}
