import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }    from '@angular/common';
import { Router, RouterModule }    from '@angular/router';
import { FormsModule }     from '@angular/forms';
import { TableModule }     from 'primeng/table';
import { ButtonModule }    from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule }       from 'primeng/tag';
import { TooltipModule }   from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ToastModule }     from 'primeng/toast';
import { EmployeeService } from '../../../shared/models/employee.service';

@Component({
  selector: 'app-employee-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './employee-list.component.css',
  imports: [
    CommonModule, RouterModule, FormsModule,
    TableModule, ButtonModule, InputTextModule,
    TagModule, TooltipModule, ConfirmDialogModule, ToastModule,
  ],
  providers: [ConfirmationService, MessageService],
  templateUrl: './employee-list.component.html',
})
export class EmployeeListComponent implements OnInit {
  employees = signal<any[]>([]);
  total     = signal(0);
  loading   = signal(false);
  search    = '';
  page      = 1;

  constructor(private svc: EmployeeService, private router: Router) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.svc.list({ page: this.page, limit: 20, search: this.search }).subscribe({
      next: (r) => {
        this.employees.set(r.data);
        this.total.set(r.pagination.total);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  loadPage(event: any) {
    this.page = (event.first / event.rows) + 1;
    this.load();
  }

  onSearch() {
    this.page = 1;
    this.load();
  }

  editEmployee(emp: any) {
    this.svc.setSelectedEmployee(emp);
    this.router.navigate([`/employees/${emp.id}/edit`], { state: { employee: emp } });
  }
}
