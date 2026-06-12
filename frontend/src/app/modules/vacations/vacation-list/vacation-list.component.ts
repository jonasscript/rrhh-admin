import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { RouterModule }  from '@angular/router';
import { FormsModule }   from '@angular/forms';
import { TableModule }   from 'primeng/table';
import { ButtonModule }  from 'primeng/button';
import { TagModule }     from 'primeng/tag';
import { DropdownModule } from 'primeng/dropdown';
import { DialogModule }  from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule }   from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { HttpClient }    from '@angular/common/http';
import { environment }   from '../../../../environments/environment';

@Component({
  selector: 'app-vacation-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './vacation-list.component.css',
  imports: [
    CommonModule, RouterModule, FormsModule,
    TableModule, ButtonModule, TagModule, DropdownModule, DialogModule, InputNumberModule, ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './vacation-list.component.html',
})
export class VacationListComponent implements OnInit {
  requests     = signal<any[]>([]);
  loading      = signal(false);
  filterStatus = '';

  constructor(private http: HttpClient, private msg: MessageService) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    const params = this.filterStatus ? `?status=${this.filterStatus}` : '';
    this.http.get<any>(`${environment.apiUrl}/vacations/requests${params}`).subscribe({
      next: (r) => { this.requests.set(r.data); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  review(id: string, status: 'APPROVED' | 'REJECTED') {
    this.http.patch<any>(`${environment.apiUrl}/vacations/requests/${id}/review`, { status }).subscribe({
      next: () => { this.msg.add({ severity: 'success', summary: 'OK', detail: `Solicitud ${status === 'APPROVED' ? 'aprobada' : 'rechazada'}` }); this.load(); },
      error: (e) => this.msg.add({ severity: 'error', summary: 'Error', detail: e.error?.message }),
    });
  }
}
