import { Component, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }    from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { DropdownModule }  from 'primeng/dropdown';
import { CheckboxModule }  from 'primeng/checkbox';
import { CalendarModule }  from 'primeng/calendar';
import { ButtonModule }    from 'primeng/button';
import { CardModule }      from 'primeng/card';
import { ToastModule }     from 'primeng/toast';
import { MessageService }  from 'primeng/api';
import { HttpClient }      from '@angular/common/http';
import { environment }     from '../../../../environments/environment';

@Component({
  selector: 'app-announcement-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './announcement-form.component.css',
  imports: [
    CommonModule, RouterModule, ReactiveFormsModule,
    InputTextModule, InputTextareaModule, DropdownModule,
    CheckboxModule, CalendarModule, ButtonModule, CardModule, ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './announcement-form.component.html',
})
export class AnnouncementFormComponent {
  form = this.fb.group({
    title:       ['', Validators.required],
    body:        ['', Validators.required],
    type:        ['INFO'],
    sendEmail:   [false],
    targetAll:   [true],
    scheduledAt: [null as string | null],
  });

  saving = signal(false);

  constructor(
    private fb:     FormBuilder,
    private http:   HttpClient,
    private router: Router,
    private msg:    MessageService,
  ) {}

  submit() {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.saving.set(true);

    this.http.post<any>(`${environment.apiUrl}/announcements`, this.form.value).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'OK', detail: 'Comunicado creado' });
        setTimeout(() => this.router.navigate(['/comunicados']), 1000);
      },
      error: (e) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: e.error?.message });
        this.saving.set(false);
      },
    });
  }
}
