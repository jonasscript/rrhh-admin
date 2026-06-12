import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { CardModule }    from 'primeng/card';
import { ButtonModule }  from 'primeng/button';
import { TagModule }     from 'primeng/tag';
import { TabViewModule } from 'primeng/tabview';
import { TableModule }   from 'primeng/table';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule }    from 'primeng/checkbox';
import { ToastModule }       from 'primeng/toast';
import { MessageService }    from 'primeng/api';
import { EmployeeService } from '../../../shared/models/employee.service';

@Component({
  selector: 'app-employee-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './employee-detail.component.css',
  imports: [
    CommonModule, RouterModule, ReactiveFormsModule,
    CardModule, ButtonModule, TagModule, TabViewModule, TableModule,
    InputNumberModule, CheckboxModule, ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './employee-detail.component.html',
})
export class EmployeeDetailComponent implements OnInit {
  emp         = signal<any>(null);
  payrolls    = signal<any[]>([]);
  obligations = signal<any>(null);
  savingObl   = signal(false);

  oblForm = this.fb.group({
    fondosReservaAplica: [false],
    iessQuirofario:      [0, [Validators.min(0)]],
    iessHipotecario:     [0, [Validators.min(0)]],
    notes:               [''],
  });

  constructor(
    private svc: EmployeeService,
    private route: ActivatedRoute,
    private fb: FormBuilder,
    private msg: MessageService,
  ) {}

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    this.svc.getOne(id).subscribe((r) => this.emp.set(r.data));
    this.svc.getPayrolls(id).subscribe((r) => this.payrolls.set(r.data));
    this.loadObligations(id);
  }

  private loadObligations(id: string) {
    this.svc.getLaborObligations(id).subscribe((r) => {
      const o = r.data;
      this.obligations.set(o);
      this.oblForm.patchValue({
        fondosReservaAplica: o.fondos_reserva_aplica ?? false,
        iessQuirofario:      parseFloat(o.iess_quirografario ?? 0),
        iessHipotecario:     parseFloat(o.iess_hipotecario  ?? 0),
        notes:               o.notes ?? '',
      });
    });
  }

  saveObligations() {
    const id = this.route.snapshot.params['id'];
    this.savingObl.set(true);
    this.svc.updateLaborObligations(id, this.oblForm.value).subscribe({
      next: (r) => {
        this.obligations.set(r.data);
        this.msg.add({ severity: 'success', summary: 'Guardado', detail: 'Obligaciones actualizadas' });
        this.savingObl.set(false);
      },
      error: () => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar' });
        this.savingObl.set(false);
      },
    });
  }
}
