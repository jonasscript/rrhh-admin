import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { RouterModule }  from '@angular/router';
import { FormsModule }   from '@angular/forms';
import { TableModule }   from 'primeng/table';
import { ButtonModule }  from 'primeng/button';
import { TagModule }     from 'primeng/tag';
import { DropdownModule } from 'primeng/dropdown';
import { ToastModule }   from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { HttpClient }    from '@angular/common/http';
import { environment }   from '../../../../environments/environment';

@Component({
  selector: 'app-announcement-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './announcement-list.component.css',
  imports: [
    CommonModule, RouterModule, FormsModule,
    TableModule, ButtonModule, TagModule, DropdownModule, ToastModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './announcement-list.component.html',
})
export class AnnouncementListComponent implements OnInit {
  announcements = signal<any[]>([]);
  loading       = signal(false);
  filterStatus  = '';

  constructor(
    private http: HttpClient,
    private msg:  MessageService,
    private conf: ConfirmationService,
  ) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    const q = this.filterStatus ? `?status=${this.filterStatus}` : '';
    this.http.get<any>(`${environment.apiUrl}/announcements${q}`).subscribe({
      next: (r) => { this.announcements.set(r.data); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  sendNow(id: string) {
    this.conf.confirm({
      message: '¿Enviar el comunicado ahora?',
      accept: () => {
        this.http.post<any>(`${environment.apiUrl}/announcements/${id}/send`, {}).subscribe({
          next: (r) => { this.msg.add({ severity: 'success', summary: 'OK', detail: r.message }); this.load(); },
          error: (e) => this.msg.add({ severity: 'error', summary: 'Error', detail: e.error?.message }),
        });
      },
    });
  }

  delete(id: string) {
    this.conf.confirm({
      message: '¿Eliminar comunicado?',
      accept: () => {
        this.http.delete<any>(`${environment.apiUrl}/announcements/${id}`).subscribe({
          next: () => this.load(),
          error: (e) => this.msg.add({ severity: 'error', summary: 'Error', detail: e.error?.message }),
        });
      },
    });
  }
}
