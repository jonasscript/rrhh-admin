import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TabViewModule } from 'primeng/tabview';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { CalendarModule } from 'primeng/calendar';
import { DropdownModule } from 'primeng/dropdown';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoFundEntry, CondoFundFacet, ProvisionCatalogItem } from '../../../shared/models/models';

type TagSeverity = 'success' | 'info' | 'secondary' | 'contrast' | 'warning' | 'danger' | undefined;

@Component({
  selector: 'app-condo-funds',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TabViewModule, CardModule, TableModule,
    ButtonModule, DialogModule, InputNumberModule, InputTextModule,
    CalendarModule, DropdownModule, TagModule, ToastModule, TooltipModule,
  ],
  providers: [MessageService],
  templateUrl: './condo-funds.component.html',
  styleUrl: './condo-funds.component.css',
})
export class CondoFundsComponent implements OnInit {
  private svc = inject(CondominiumService);
  private msg = inject(MessageService);

  // Catalog + summary
  catalog: ProvisionCatalogItem[] = [];
  summary: Record<string, CondoFundFacet> = {};
  loadingSummary = false;

  // Entries per provision (loaded on tab selection)
  entriesMap: Record<string, CondoFundEntry[] | undefined> = {};
  loadingEntries: Record<string, boolean> = {};

  // Dialog state
  showDialog   = false;
  saving       = false;
  dialogProvId = '';
  entryAmount      = 0;
  entryType        = 'EXPENDITURE';
  entryDescription = '';
  entryDate: Date  = new Date();
  isNegative       = true;

  entryTypeOptions = [
    { label: 'Egreso / Pago',   value: 'EXPENDITURE', hint: 'Sale dinero del fondo' },
    { label: 'Castigo deuda',   value: 'WRITE_OFF',   hint: 'Aplicar provisión por incobrable confirmado' },
    { label: 'Reversión',       value: 'REVERSAL',    hint: 'Recuperación parcial o total (ingresa al fondo)' },
    { label: 'Ajuste',          value: 'ADJUSTMENT',  hint: 'Corrección contable manual' },
  ];

  ngOnInit() { this.loadAll(); }

  loadAll() {
    this.loadingSummary = true;
    this.svc.getProvisionCatalog().subscribe({
      next: (cat) => {
        this.catalog = cat;
        this.svc.getFundSummary().subscribe({
          next: (s) => { this.summary = s; this.loadingSummary = false; },
          error: () => { this.loadingSummary = false; },
        });
      },
      error: () => { this.loadingSummary = false; },
    });
  }

  loadEntries(provisionId: string) {
    if (this.entriesMap[provisionId]) return; // already loaded
    this.loadingEntries[provisionId] = true;
    this.svc.getFundEntries(provisionId, 200).subscribe({
      next: (e) => {
        this.entriesMap[provisionId] = e;
        this.loadingEntries[provisionId] = false;
      },
      error: () => { this.loadingEntries[provisionId] = false; },
    });
  }

  onTabChange(index: number) {
    const prov = this.catalog[index];
    if (prov) this.loadEntries(prov.id);
  }

  getFacet(provisionId: string): CondoFundFacet | null {
    return this.summary[provisionId] ?? null;
  }

  openDialog(provisionId: string) {
    this.dialogProvId    = provisionId;
    this.entryAmount     = 0;
    this.entryType       = 'EXPENDITURE';
    this.entryDescription = '';
    this.entryDate       = new Date();
    this.isNegative      = true;
    this.showDialog      = true;
  }

  save() {
    if (!this.entryDescription.trim() || this.entryAmount <= 0) return;
    this.saving = true;
    this.svc.createFundEntry({
      provision_id: this.dialogProvId,
      amount:       this.entryAmount,
      entry_type:   this.entryType,
      description:  this.entryDescription,
      entry_date:   this.entryDate.toISOString().slice(0, 10),
      is_negative:  this.isNegative,
    }).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Movimiento registrado' });
        this.showDialog = false;
        this.saving = false;
        // Refresh entries for this provision
        delete this.entriesMap[this.dialogProvId];
        this.loadEntries(this.dialogProvId);
        this.loadingSummary = true;
        this.svc.getFundSummary().subscribe({
          next: (s) => { this.summary = s; this.loadingSummary = false; },
          error: () => { this.loadingSummary = false; },
        });
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.saving = false;
      },
    });
  }

  get dialogProvName(): string {
    return this.catalog.find(p => p.id === this.dialogProvId)?.name ?? '';
  }

  entryTypeSeverity(t: string): TagSeverity {
    return t === 'PROVISION' ? 'success' :
           t === 'EXPENDITURE' ? 'danger' :
           t === 'WRITE_OFF' ? 'warning' :
           t === 'REVERSAL' ? 'info' : 'secondary';
  }

  entryTypeLabel(t: string): string {
    const map: Record<string, string> = {
      PROVISION: 'Provisión', EXPENDITURE: 'Egreso',
      WRITE_OFF: 'Castigo', REVERSAL: 'Reversión', ADJUSTMENT: 'Ajuste',
    };
    return map[t] || t;
  }

  get isAdjustment() { return this.entryType === 'ADJUSTMENT'; }
}
