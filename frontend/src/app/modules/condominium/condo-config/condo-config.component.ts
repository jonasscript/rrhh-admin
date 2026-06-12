import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CondominiumService } from '../../../shared/models/condominium.service';

@Component({
  selector: 'app-condo-config',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, CardModule, InputTextModule, InputNumberModule, ButtonModule, ToastModule],
  providers: [MessageService],
  templateUrl: './condo-config.component.html',
  styleUrl: './condo-config.component.css',
})
export class CondoConfigComponent implements OnInit {
  private svc = inject(CondominiumService);
  private fb = inject(FormBuilder);
  private msg = inject(MessageService);
  saving = false;

  form = this.fb.group({
    condoName: ['', Validators.required],
    address: [''],
    adminEmail: ['', [Validators.required, Validators.email]],
    fixedExpenses: [0, [Validators.required, Validators.min(0)]],
  });

  ngOnInit() {
    this.svc.getConfig().subscribe({ next: (cfg) => { if (cfg) this.form.patchValue(cfg as any); } });
  }

  save() {
    if (this.form.invalid) return;
    this.saving = true;
    this.svc.saveConfig(this.form.value as any).subscribe({
      next: () => { this.msg.add({ severity: 'success', summary: 'Configuración guardada', detail: '' }); this.saving = false; },
      error: (err) => { this.msg.add({ severity: 'error', summary: 'Error', detail: err.error?.message }); this.saving = false; },
    });
  }
}
