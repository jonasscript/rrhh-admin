import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }     from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { InputTextModule }  from 'primeng/inputtext';
import { DropdownModule }   from 'primeng/dropdown';
import { ButtonModule }     from 'primeng/button';
import { CalendarModule }   from 'primeng/calendar';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule }   from 'primeng/checkbox';
import { CardModule }       from 'primeng/card';
import { ToastModule }      from 'primeng/toast';
import { MessageService }   from 'primeng/api';
import { EmployeeService }  from '../../../shared/models/employee.service';

@Component({
  selector: 'app-employee-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './employee-form.component.css',
  imports: [
    CommonModule, RouterModule, ReactiveFormsModule,
    InputTextModule, DropdownModule, ButtonModule, CalendarModule,
    InputNumberModule, CheckboxModule, CardModule, ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './employee-form.component.html',
})
export class EmployeeFormComponent implements OnInit {
  form       = this.fb.group({
    firstName:    ['', Validators.required],
    lastName:     ['', Validators.required],
    cedula:       ['', Validators.required],
    email:        ['', [Validators.required, Validators.email]],
    phone:        [''],
    departmentId: [null as string | null],
    position:     ['', Validators.required],
    contractType: ['INDEFINIDO', Validators.required],
    startDate:    [null as Date | null, Validators.required],
    baseSalary:   [460, [Validators.required, Validators.min(1)]],
    iessAffiliate:        [true],
    status:               ['ACTIVE'],
    createUser:           [false],
  });

  departments = signal<any[]>([]);
  saving      = signal(false);
  isEdit      = false;
  employeeId  = '';

  constructor(
    private fb:   FormBuilder,
    private svc:  EmployeeService,
    private route: ActivatedRoute,
    private router: Router,
    private msg:  MessageService,
  ) {}

  ngOnInit() {
    this.svc.listDepartments().subscribe((r) => this.departments.set(r.data));

    this.employeeId = this.route.snapshot.params['id'];
    if (this.employeeId && this.employeeId !== 'nuevo') {
      this.isEdit = true;
      const navEmployee = (history.state?.employee ?? null) as any | null;
      const memEmployee = this.svc.getSelectedEmployee();
      const selectedEmployee = this.pickSelectedEmployee(navEmployee, memEmployee, this.employeeId);

      if (selectedEmployee) {
        this.patchFormFromEmployee(selectedEmployee);
        return;
      }

      this.svc.getOne(this.employeeId).subscribe((r) => this.patchFormFromEmployee(r.data));
    }
  }

  private pickSelectedEmployee(navEmployee: any | null, memEmployee: any | null, employeeId: string) {
    if (navEmployee && String(navEmployee.id) === String(employeeId)) return navEmployee;
    if (memEmployee && String(memEmployee.id) === String(employeeId)) return memEmployee;
    return null;
  }

  private patchFormFromEmployee(emp: any) {
    this.form.patchValue({
      firstName: emp.firstName ?? emp.first_name ?? '',
      lastName: emp.lastName ?? emp.last_name ?? '',
      cedula: emp.cedula ?? '',
      email: emp.email ?? '',
      phone: emp.phone ?? '',
      departmentId: emp.departmentId ?? emp.department_id ?? null,
      position: emp.position ?? '',
      contractType: emp.contractType ?? emp.contract_type ?? 'INDEFINIDO',
      startDate: this.normalizeDate(emp.startDate ?? emp.start_date),
      baseSalary: emp.baseSalary ?? emp.base_salary ?? 460,
      iessAffiliate:       emp.iessAffiliate       ?? emp.iess_affiliate        ?? true,
      status:              emp.status              ?? 'ACTIVE',
    });
  }

  private normalizeDate(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  submit() {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.saving.set(true);

    const obs = this.isEdit
      ? this.svc.update(this.employeeId, this.form.value)
      : this.svc.create(this.form.value);

    obs.subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'Éxito', detail: this.isEdit ? 'Empleado actualizado' : 'Empleado creado' });
        setTimeout(() => this.router.navigate(['/employees']), 1000);
      },
      error: (e) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: e.error?.message || 'Error al guardar' });
        this.saving.set(false);
      },
    });
  }
}
