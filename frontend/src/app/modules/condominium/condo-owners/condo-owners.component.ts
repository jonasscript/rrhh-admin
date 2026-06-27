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
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoOwner } from '../../../shared/models/models';

@Component({
  selector: 'app-condo-owners',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, TableModule, ButtonModule, DialogModule,
    InputTextModule, InputNumberModule, TagModule, TooltipModule, ToastModule],
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
  editingOwner: CondoOwner | null = null;
  moraOwner: CondoOwner | null = null;
  moraOperation: 'ADD' | 'SUBTRACT' | 'SET' = 'SUBTRACT';
  moraAmount = 0;
  importResult: { inserted: number; updated: number; errors: { row: number; unit: string; reason: string }[] } | null = null;

  form = this.fb.group({
    apartmentNumber: ['', Validators.required],
    fullName: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    phone: [''],
    participationPct: [null as number | null, [Validators.required, Validators.min(0.01), Validators.max(100)]],
  });

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
}
