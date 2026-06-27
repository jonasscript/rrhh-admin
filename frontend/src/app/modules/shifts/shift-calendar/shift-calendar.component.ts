import { Component, OnInit, ChangeDetectionStrategy, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CalendarModule } from 'primeng/calendar';
import { DropdownModule } from 'primeng/dropdown';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';

type RotationRole = 'morning' | 'afternoon' | 'night' | 'rest';

interface ShiftTemplate {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  color: string;
}

interface Assignment {
  id: string;
  employee_id: string;
  shift_template_id: string;
  first_name: string;
  last_name: string;
  date: string;
  shift_name: string;
  start_time: string;
  end_time: string;
  color: string;
}

interface RotationRoleView {
  key: RotationRole;
  label: string;
  templateId: string;
  color: string;
  schedule: string;
}

const ROLE_META: Record<RotationRole, { label: string; match: string[] }> = {
  morning: { label: 'Mañana',   match: ['mañana', 'manana', 'diurno'] },
  afternoon: { label: 'Tarde',  match: ['tarde', 'vespertino'] },
  night: { label: 'Noche',      match: ['noche', 'nocturno'] },
  rest: { label: 'Descanso',    match: ['descanso'] },
};

@Component({
  selector: 'app-shift-calendar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './shift-calendar.component.css',
  imports: [
    CommonModule, FormsModule, ButtonModule, CalendarModule, DropdownModule,
    MultiSelectModule, CheckboxModule, DialogModule, ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './shift-calendar.component.html',
})
export class ShiftCalendarComponent implements OnInit {
  assignments = signal<Assignment[]>([]);
  guards = signal<{ label: string; value: string }[]>([]);
  templates = signal<ShiftTemplate[]>([]);
  currentMonth = signal(this.firstDayOfMonth(new Date()));
  loading = signal(false);
  saving = signal(false);
  generating = signal(false);
  downloading = signal(false);

  showGenerateDialog = false;
  showManualDialog = false;

  generation = {
    employeeIds: [] as string[],
    morningShiftTemplateId: '',
    afternoonShiftTemplateId: '',
    nightShiftTemplateId: '',
    restShiftTemplateId: '',
    overwrite: false,
  };
  manual = { employeeId: '', shiftTemplateId: '', date: null as Date | null, assignmentId: '' };

  readonly monthDays = computed(() => {
    const month = this.currentMonth();
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return Array.from({ length: lastDay }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1));
  });

  readonly weekGroups = computed(() => {
    const days = this.monthDays();
    if (!days.length) return [] as (Date | null)[][];
    const first = days[0];
    const last = days[days.length - 1];
    const cursor = new Date(first);
    cursor.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const weeks: (Date | null)[][] = [];
    while (cursor <= last) {
      const week: (Date | null)[] = [];
      for (let i = 0; i < 7; i++) {
        const day = new Date(cursor);
        day.setDate(cursor.getDate() + i);
        week.push(day.getMonth() === first.getMonth() ? day : null);
      }
      weeks.push(week);
      cursor.setDate(cursor.getDate() + 7);
    }
    return weeks;
  });

  constructor(private http: HttpClient, private msg: MessageService) {}

  ngOnInit() {
    this.loadTemplates();
    this.http.get<any>(`${environment.apiUrl}/employees?limit=100&status=ACTIVE`).subscribe({
      next: (response) => {
        const guards = response.data.map((employee: any) => ({
          label: `${employee.first_name} ${employee.last_name}`,
          value: employee.id,
        }));
        this.guards.set(guards);
        if (guards.length === 4) this.generation.employeeIds = guards.map((guard: any) => guard.value);
      },
      error: () => this.msg.add({ severity: 'error', summary: 'No se pudieron cargar los guardias' }),
    });
    this.loadMonth();
  }

  loadTemplates() {
    this.http.get<any>(`${environment.apiUrl}/shifts/templates`).subscribe({
      next: (response) => {
        this.templates.set(response.data);
        this.setSuggestedTemplates();
      },
      error: () => this.msg.add({ severity: 'error', summary: 'No se pudieron cargar las plantillas de turno' }),
    });
  }

  loadMonth() {
    const start = this.toIsoDate(this.monthDays()[0]);
    const end = this.toIsoDate(this.monthDays()[this.monthDays().length - 1]);
    this.loading.set(true);
    this.http.get<any>(`${environment.apiUrl}/shifts/assignments?start=${start}&end=${end}`).subscribe({
      next: (response) => {
        this.assignments.set(response.data);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.msg.add({ severity: 'error', summary: 'No se pudo cargar el horario' });
      },
    });
  }

  rotationRoles(): RotationRoleView[] {
    return (Object.keys(ROLE_META) as RotationRole[]).map((key) => {
      const templateId = this.generation[`${key}ShiftTemplateId` as keyof typeof this.generation] as string;
      const template = this.templates().find((item) => item.id === templateId);
      return {
        key,
        label: ROLE_META[key].label,
        templateId,
        color: template?.color || '#94a3b8',
        schedule: key === 'rest' ? 'Día libre' : template ? `${this.shortTime(template.start_time)} – ${this.shortTime(template.end_time)}` : 'Sin configurar',
      };
    });
  }

  getRoleAssignment(day: Date, role: RotationRoleView): Assignment | undefined {
    const date = this.toIsoDate(day);
    if (role.templateId) {
      return this.assignments().find((item) => item.date.slice(0, 10) === date && item.shift_template_id === role.templateId);
    }
    return this.assignments().find((item) => item.date.slice(0, 10) === date && this.matchesRole(item.shift_name, role.key));
  }

  scheduleComplete(): boolean {
    const roles = this.rotationRoles();
    return roles.every((role) => !!role.templateId) && this.monthDays().every((day) => {
      const assigned = roles.map((role) => this.getRoleAssignment(day, role));
      return assigned.every(Boolean) && new Set(assigned.map((item) => item!.employee_id)).size === 4;
    });
  }

  filledCells(): number {
    return this.monthDays().reduce((total, day) =>
      total + this.rotationRoles().filter((role) => !!this.getRoleAssignment(day, role)).length, 0);
  }

  expectedCells(): number { return this.monthDays().length * 4; }

  prevMonth() {
    const month = this.currentMonth();
    this.currentMonth.set(new Date(month.getFullYear(), month.getMonth() - 1, 1));
    this.loadMonth();
  }

  nextMonth() {
    const month = this.currentMonth();
    this.currentMonth.set(new Date(month.getFullYear(), month.getMonth() + 1, 1));
    this.loadMonth();
  }

  goToday() {
    this.currentMonth.set(this.firstDayOfMonth(new Date()));
    this.loadMonth();
  }

  openGenerateDialog() {
    this.setSuggestedTemplates();
    this.showGenerateDialog = true;
  }

  openManualAssignment(day?: Date, role?: RotationRoleView) {
    const assignment = day && role ? this.getRoleAssignment(day, role) : undefined;
    this.manual = {
      employeeId: assignment?.employee_id || '',
      shiftTemplateId: assignment?.shift_template_id || role?.templateId || '',
      date: day ? new Date(day) : new Date(this.currentMonth()),
      assignmentId: assignment?.id || '',
    };
    this.showManualDialog = true;
  }

  generateRotation() {
    if (this.generation.employeeIds.length !== 4) {
      this.msg.add({ severity: 'warn', summary: 'Selecciona cuatro guardias', detail: 'La rotación del ejemplo requiere cuatro guardias.' });
      return;
    }
    const days = this.monthDays();
    this.generating.set(true);
    this.http.post<any>(`${environment.apiUrl}/shifts/rotation/generate`, {
      ...this.generation,
      startDate: this.toIsoDate(days[0]),
      endDate: this.toIsoDate(days[days.length - 1]),
    }).subscribe({
      next: (response) => {
        const ids = response.data?.roleTemplateIds;
        if (ids) {
          this.generation.morningShiftTemplateId = ids.morning || this.generation.morningShiftTemplateId;
          this.generation.afternoonShiftTemplateId = ids.afternoon || this.generation.afternoonShiftTemplateId;
          this.generation.nightShiftTemplateId = ids.night || this.generation.nightShiftTemplateId;
          this.generation.restShiftTemplateId = ids.rest || this.generation.restShiftTemplateId;
        }
        this.generating.set(false);
        this.showGenerateDialog = false;
        this.loadTemplates();
        this.loadMonth();
        this.msg.add({ severity: 'success', summary: 'Horario generado', detail: response.message });
      },
      error: (error) => {
        this.generating.set(false);
        this.msg.add({ severity: 'error', summary: 'No se pudo generar', detail: error.error?.message || 'Inténtalo nuevamente.' });
      },
    });
  }

  saveManualAssignment() {
    if (!this.manual.employeeId || !this.manual.shiftTemplateId || !this.manual.date) {
      this.msg.add({ severity: 'warn', summary: 'Completa todos los campos obligatorios' });
      return;
    }
    this.saving.set(true);
    const request = {
      employeeId: this.manual.employeeId,
      shiftTemplateId: this.manual.shiftTemplateId,
      date: this.toIsoDate(this.manual.date),
    };
    const save = this.manual.assignmentId
      ? this.http.put<any>(`${environment.apiUrl}/shifts/assignments/${this.manual.assignmentId}`, request)
      : this.http.post<any>(`${environment.apiUrl}/shifts/assignments`, request);
    save.subscribe({
      next: () => {
        this.saving.set(false);
        this.showManualDialog = false;
        this.loadMonth();
        this.msg.add({ severity: 'success', summary: 'Turno guardado' });
      },
      error: (error) => {
        this.saving.set(false);
        this.msg.add({ severity: 'error', summary: 'No se pudo guardar', detail: error.error?.message });
      },
    });
  }

  removeManualAssignment() {
    if (!this.manual.assignmentId) return;
    this.saving.set(true);
    this.http.delete<any>(`${environment.apiUrl}/shifts/assignments/${this.manual.assignmentId}`).subscribe({
      next: () => {
        this.saving.set(false);
        this.showManualDialog = false;
        this.loadMonth();
        this.msg.add({ severity: 'success', summary: 'Turno eliminado' });
      },
      error: (error) => {
        this.saving.set(false);
        this.msg.add({ severity: 'error', summary: 'No se pudo eliminar', detail: error.error?.message });
      },
    });
  }

  exportPdf() {
    if (!this.scheduleComplete()) return;
    const days = this.monthDays();
    this.downloading.set(true);
    const start = this.toIsoDate(days[0]);
    const end = this.toIsoDate(days[days.length - 1]);
    this.http.get(`${environment.apiUrl}/shifts/schedule/pdf?start=${start}&end=${end}`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `horario-guardias-${start}.pdf`;
        anchor.click();
        URL.revokeObjectURL(url);
        this.downloading.set(false);
      },
      error: (error) => {
        this.downloading.set(false);
        this.msg.add({ severity: 'error', summary: 'No se pudo exportar el PDF', detail: error.error?.message });
      },
    });
  }

  weekLabel(week: (Date | null)[]): string {
    const validDays = week.filter((day): day is Date => !!day);
    if (!validDays.length) return '';
    return `Semana del ${validDays[0].getDate()} al ${validDays[validDays.length - 1].getDate()}`;
  }

  employeeName(assignment: Assignment): string { return `${assignment.first_name} ${assignment.last_name}`; }
  isToday(day: Date): boolean { return this.toIsoDate(day) === this.toIsoDate(new Date()); }
  shortTime(time: string): string { return String(time || '').slice(0, 5); }

  private setSuggestedTemplates() {
    for (const key of Object.keys(ROLE_META) as RotationRole[]) {
      const field = `${key}ShiftTemplateId` as keyof typeof this.generation;
      if (this.generation[field]) continue;
      const template = this.templates().find((item) => this.matchesRole(item.name, key));
      if (template) (this.generation[field] as string) = template.id;
    }
  }

  private matchesRole(name: string, role: RotationRole): boolean {
    const normalized = String(name || '').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return ROLE_META[role].match.some((word) => normalized.includes(word));
  }

  private firstDayOfMonth(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1); }

  private toIsoDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}
