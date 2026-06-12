import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { FormsModule }   from '@angular/forms';
import { ButtonModule }  from 'primeng/button';
import { CalendarModule } from 'primeng/calendar';
import { DropdownModule } from 'primeng/dropdown';
import { DialogModule }  from 'primeng/dialog';
import { ToastModule }   from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { HttpClient }    from '@angular/common/http';
import { environment }   from '../../../../environments/environment';

interface Assignment {
  id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  date: string;
  shift_name: string;
  start_time: string;
  end_time: string;
  color: string;
}

@Component({
  selector: 'app-shift-calendar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './shift-calendar.component.css',
  imports: [CommonModule, FormsModule, ButtonModule, CalendarModule, DropdownModule, DialogModule, ToastModule],
  providers: [MessageService],
  templateUrl: './shift-calendar.component.html',
})
export class ShiftCalendarComponent implements OnInit {
  assignments   = signal<Assignment[]>([]);
  employees     = signal<{label: string; value: string}[]>([]);
  templates     = signal<{label: string; value: string}[]>([]);
  currentMonday = signal(this.getMonday(new Date()));
  weekDays      = signal<Date[]>([]);
  loading       = signal(false);
  saving        = signal(false);
  showDialog    = false;

  newAssign = { employeeId: '', shiftTemplateId: '', date: '' };

  constructor(private http: HttpClient, private msg: MessageService) {}

  ngOnInit() {
    this.updateWeek();
    this.http.get<any>(`${environment.apiUrl}/shifts/templates`).subscribe(
      (r) => this.templates.set(r.data.map((t: any) => ({ label: t.name, value: t.id })))
    );
    this.http.get<any>(`${environment.apiUrl}/employees?limit=100`).subscribe(
      (r) => this.employees.set(r.data.map((e: any) => ({ label: `${e.first_name} ${e.last_name}`, value: e.id })))
    );
  }

  updateWeek() {
    const monday = this.currentMonday();
    const days   = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
    this.weekDays.set(days);
    this.loadAssignments(days[0], days[6]);
  }

  loadAssignments(start: Date, end: Date) {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    this.loading.set(true);
    this.http.get<any>(
      `${environment.apiUrl}/shifts/assignments?start=${fmt(start)}&end=${fmt(end)}`
    ).subscribe({
      next: (r) => { this.assignments.set(r.data); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  weekStart()  { return this.weekDays()[0] || new Date(); }
  weekEnd()    { return this.weekDays()[6] || new Date(); }

  prevWeek() {
    const d = new Date(this.currentMonday());
    d.setDate(d.getDate() - 7);
    this.currentMonday.set(d);
    this.updateWeek();
  }

  nextWeek() {
    const d = new Date(this.currentMonday());
    d.setDate(d.getDate() + 7);
    this.currentMonday.set(d);
    this.updateWeek();
  }

  goToday() {
    this.currentMonday.set(this.getMonday(new Date()));
    this.updateWeek();
  }

  getMonday(d: Date) {
    const date = new Date(d);
    const day  = date.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  uniqueEmployees() {
    const map = new Map<string, { id: string; name: string }>();
    for (const a of this.assignments()) {
      if (!map.has(a.employee_id)) {
        map.set(a.employee_id, { id: a.employee_id, name: `${a.first_name} ${a.last_name}` });
      }
    }
    return Array.from(map.values());
  }

  getAssignment(empId: string, day: Date) {
    const iso = day.toISOString().slice(0, 10);
    return this.assignments().filter(
      (a) => a.employee_id === empId && a.date.slice(0, 10) === iso
    );
  }

  assign() {
    if (!this.newAssign.employeeId || !this.newAssign.shiftTemplateId || !this.newAssign.date) return;
    this.saving.set(true);
    this.http.post<any>(`${environment.apiUrl}/shifts/assignments`, {
      employeeId:      this.newAssign.employeeId,
      shiftTemplateId: this.newAssign.shiftTemplateId,
      date:            this.newAssign.date,
    }).subscribe({
      next: () => {
        this.msg.add({ severity: 'success', summary: 'OK', detail: 'Turno asignado' });
        this.showDialog  = false;
        this.saving.set(false);
        this.updateWeek();
      },
      error: (e) => {
        this.msg.add({ severity: 'error', summary: 'Error', detail: e.error?.message });
        this.saving.set(false);
      },
    });
  }
}
