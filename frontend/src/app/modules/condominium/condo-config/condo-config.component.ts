import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { CardModule } from 'primeng/card';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { DividerModule } from 'primeng/divider';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';

@Component({
  selector: 'app-condo-config',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, FormsModule, RouterModule, CardModule, InputTextModule,
    InputNumberModule, SelectButtonModule, ToggleButtonModule,
    DividerModule, ButtonModule, ToastModule, TagModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './condo-config.component.html',
  styleUrl: './condo-config.component.css',
})
export class CondoConfigComponent implements OnInit {
  private svc  = inject(CondominiumService);
  private fb   = inject(FormBuilder);
  private msg  = inject(MessageService);
  private conf = inject(ConfirmationService);

  saving = false;

  // ── General config form ──────────────────────────────────────
  form = this.fb.group({
    name:             ['', Validators.required],
    adminEmail:       ['', [Validators.required, Validators.email]],
    fixedMaintenance: [0, Validators.min(0)],
    fixedSecurity:    [0, Validators.min(0)],
    fixedCleaning:    [0, Validators.min(0)],
    fixedOther:       [0, Validators.min(0)],
    moraEnabled:      [true],
    moraRate:         [0.02, [Validators.min(0), Validators.max(1)]],
    moraGraceDays:    [5,    [Validators.min(0), Validators.max(90)]],
  });

  ngOnInit() {
    this.svc.getConfig().subscribe({
      next: (cfg) => {
        if (!cfg) return;
        this.form.patchValue({
          name:             cfg.name,
          adminEmail:       cfg.admin_email,
          fixedMaintenance: cfg.fixed_maintenance,
          fixedSecurity:    cfg.fixed_security,
          fixedCleaning:    cfg.fixed_cleaning,
          fixedOther:       cfg.fixed_other,
          moraEnabled:      cfg.mora_enabled,
          moraRate:         cfg.mora_rate,
          moraGraceDays:    cfg.mora_grace_days,
        });
      },
    });
  }

  save() {
    if (this.form.invalid) return;
    this.saving = true;
    this.svc.saveConfig(this.form.value as any).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Configuración guardada' });
        this.saving = false;
      },
      error: (err) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message });
        this.saving = false;
      },
    });
  }
}
