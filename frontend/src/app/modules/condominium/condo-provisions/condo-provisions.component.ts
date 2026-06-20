import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DividerModule } from 'primeng/divider';
import { MessageService, ConfirmationService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { ProvisionCatalogItem } from '../../../shared/models/models';

@Component({
  selector: 'app-condo-provisions',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    TableModule, ButtonModule, TagModule, DialogModule,
    InputTextModule, InputTextareaModule, InputNumberModule,
    SelectButtonModule, ToggleButtonModule,
    ToastModule, TooltipModule, ConfirmDialogModule, DividerModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './condo-provisions.component.html',
  styleUrl: './condo-provisions.component.css',
})
export class CondoProvisionsComponent implements OnInit {
  private svc  = inject(CondominiumService);
  private msg  = inject(MessageService);
  private conf = inject(ConfirmationService);

  provisions: ProvisionCatalogItem[] = [];
  loading   = false;
  saving    = false;

  showDialog   = false;
  editing: ProvisionCatalogItem | null = null;

  // ── Form fields ──────────────────────────────────────────
  name        = '';
  description = '';
  calcType    = 'PERCENTAGE';
  value       = 0;
  isActive    = true;
  sortOrder   = 0;

  calcTypeOptions = [
    { label: '% Porcentaje', value: 'PERCENTAGE' },
    { label: '$ Monto fijo', value: 'FIXED'       },
    { label: '✎ Variable',   value: 'VARIABLE'    },
  ];

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    this.svc.getProvisionCatalog().subscribe({
      next:  (p) => { this.provisions = p; this.loading = false; },
      error: ()  => { this.loading = false; },
    });
  }

  openNew() {
    this.editing     = null;
    this.name        = '';
    this.description = '';
    this.calcType    = 'PERCENTAGE';
    this.value       = 0;
    this.isActive    = true;
    this.sortOrder   = 0;
    this.showDialog  = true;
  }

  openEdit(p: ProvisionCatalogItem) {
    this.editing     = p;
    this.name        = p.name;
    this.description = p.description;
    this.calcType    = p.calc_type;
    this.value       = p.value;
    this.isActive    = p.is_active;
    this.sortOrder   = p.sort_order;
    this.showDialog  = true;
  }

  save() {
    if (!this.name.trim()) return;
    if (this.calcType !== 'VARIABLE' && this.value < 0) return;
    this.saving = true;
    const payload = {
      name:        this.name.trim(),
      description: this.description.trim(),
      calcType:    this.calcType,
      value:       this.calcType === 'VARIABLE' ? 0 : this.value,
      isActive:    this.isActive,
      sortOrder:   this.sortOrder,
    };
    const op = this.editing
      ? this.svc.updateProvision(this.editing.id, payload)
      : this.svc.createProvision(payload as any);
    op.subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: this.editing ? 'Provisión actualizada' : 'Provisión creada' });
        this.showDialog = false;
        this.saving = false;
        this.load();
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.saving = false;
      },
    });
  }

  toggleActive(p: ProvisionCatalogItem) {
    this.svc.updateProvision(p.id, { isActive: !p.is_active }).subscribe({
      next:  ()    => this.load(),
      error: (err) => this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }),
    });
  }

  delete(p: ProvisionCatalogItem) {
    this.conf.confirm({
      header:  'Eliminar provisión',
      message: `¿Eliminar "${p.name}"? Solo es posible si no tiene movimientos. Puede desactivarla como alternativa.`,
      icon:    'pi pi-trash',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.svc.deleteProvision(p.id).subscribe({
          next:  ()    => { this.msg.add({ severity: 'success', summary: 'Provisión eliminada' }); this.load(); },
          error: (err) => this.msg.add({ severity: 'error', summary: 'No se puede eliminar', detail: err.error?.message }),
        });
      },
    });
  }

  calcLabel(type: string): string {
    return type === 'PERCENTAGE' ? 'Porcentaje' : type === 'FIXED' ? 'Monto fijo' : 'Variable';
  }
  calcSeverity(type: string): 'info' | 'warning' | 'secondary' {
    return type === 'PERCENTAGE' ? 'info' : type === 'FIXED' ? 'warning' : 'secondary';
  }
}
