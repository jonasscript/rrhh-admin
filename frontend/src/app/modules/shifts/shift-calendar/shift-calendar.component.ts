import { Component, OnInit, ChangeDetectionStrategy, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CalendarModule } from 'primeng/calendar';
import { DropdownModule } from 'primeng/dropdown';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService, PrimeNGConfig } from 'primeng/api';
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

interface VacationBlock {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  reason?: string;
  firstName: string;
  lastName: string;
}

interface RotationRoleView {
  key: RotationRole;
  label: string;
  templateId: string;
  color: string;
  schedule: string;
}

const ROLE_META: Record<RotationRole, { label: string; match: string[]; startTime: string; endTime: string }> = {
  morning: { label: 'Mañana',   match: ['mañana', 'manana', 'diurno'], startTime: '07:00', endTime: '15:00' },
  afternoon: { label: 'Tarde',  match: ['tarde', 'vespertino'], startTime: '15:00', endTime: '21:00' },
  night: { label: 'Noche',      match: ['noche', 'nocturno'], startTime: '21:00', endTime: '07:00' },
  rest: { label: 'Descanso',    match: ['descanso'], startTime: '00:00', endTime: '00:00' },
};
const GUARDS_PER_ROTATION = 4;
const CALENDAR_SPANISH_LOCALE = {
  firstDayOfWeek: 1,
  dayNames: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  dayNamesShort: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  dayNamesMin: ['D', 'L', 'M', 'X', 'J', 'V', 'S'],
  monthNames: [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ],
  monthNamesShort: [
    'ene', 'feb', 'mar', 'abr', 'may', 'jun',
    'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
  ],
  today: 'Hoy',
  clear: 'Limpiar',
  dateFormat: 'dd/mm/yy',
  weekHeader: 'Sem',
};

@Component({
  selector: 'app-shift-calendar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './shift-calendar.component.css',
  imports: [
    CommonModule, FormsModule, ButtonModule, CalendarModule, DropdownModule,
    MultiSelectModule, CheckboxModule, InputNumberModule, DialogModule, ToastModule, TooltipModule,
    InputTextModule,
  ],
  providers: [MessageService],
  templateUrl: './shift-calendar.component.html',
})
export class ShiftCalendarComponent implements OnInit {
  readonly calendarLocale = CALENDAR_SPANISH_LOCALE;

  assignments = signal<Assignment[]>([]);
  vacations = signal<VacationBlock[]>([]);
  guards = signal<{ label: string; value: string }[]>([]);
  templates = signal<ShiftTemplate[]>([]);
  currentMonth = signal(this.firstDayOfMonth(new Date()));
  loading = signal(false);
  saving = signal(false);
  generating = signal(false);
  downloading = signal(false);

  showGenerateDialog = false;
  showManualDialog = false;
  showVacationDialog = false;

  generation = {
    employeeIds: [] as string[],
    morningShiftTemplateId: '',
    afternoonShiftTemplateId: '',
    nightShiftTemplateId: '',
    restShiftTemplateId: '',
    overwrite: false,
  };
  manual = { employeeId: '', shiftTemplateId: '', date: null as Date | null, assignmentId: '' };
  vacationForm = {
    employeeId: '',
    replacementEmployeeId: '',
    startDate: null as Date | null,
    endDate: null as Date | null,
    daysRequested: 15,
    reason: '',
    reorganize: true,
  };

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

  constructor(private http: HttpClient, private msg: MessageService, private primeNgConfig: PrimeNGConfig) {
    this.primeNgConfig.setTranslation(CALENDAR_SPANISH_LOCALE);
  }

  ngOnInit() {
    this.loadTemplates();
    this.http.get<any>(`${environment.apiUrl}/employees?limit=100&status=ACTIVE`).subscribe({
      next: (response) => {
        const guards = response.data.map((employee: any) => ({
          label: `${employee.first_name} ${employee.last_name}`,
          value: employee.id,
        }));
        this.guards.set(guards);
        if (guards.length === GUARDS_PER_ROTATION) this.generation.employeeIds = guards.map((guard: any) => guard.value);
      },
      error: () => this.msg.add({ severity: 'error', summary: 'No se pudieron cargar los guardias' }),
    });
    this.loadMonth();
  }

  loadTemplates() {
    this.http.get<any>(`${environment.apiUrl}/shifts/templates`).subscribe({
      next: (response) => {
        this.templates.set(response.data.map((template: ShiftTemplate) => this.withOfficialTimes(template)));
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
        this.assignments.set(response.data.map((assignment: Assignment) => this.withOfficialTimes(assignment)));
        this.loading.set(false);
        this.loadVacations();
      },
      error: () => {
        this.loading.set(false);
        this.msg.add({ severity: 'error', summary: 'No se pudo cargar el horario' });
      },
    });
  }

  loadVacations() {
    const start = this.toIsoDate(this.monthDays()[0]);
    const end = this.toIsoDate(this.monthDays()[this.monthDays().length - 1]);
    this.http.get<any>(`${environment.apiUrl}/shifts/vacations?start=${start}&end=${end}`).subscribe({
      next: (response) => this.vacations.set(response.data || []),
      error: () => this.msg.add({ severity: 'error', summary: 'No se pudieron cargar las vacaciones' }),
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
        schedule: this.officialSchedule(key),
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
      return assigned.every(Boolean) && new Set(assigned.map((item) => item!.employee_id)).size === roles.length;
    });
  }

  filledCells(): number {
    return this.monthDays().reduce((total, day) =>
      total + this.rotationRoles().filter((role) => !!this.getRoleAssignment(day, role)).length, 0);
  }

  expectedCells(): number { return this.monthDays().length * this.rotationRoles().length; }

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
    if (day && this.manual.employeeId && this.isEmployeeOnVacation(this.manual.employeeId, day)) {
      this.manual.employeeId = '';
    }
    this.showManualDialog = true;
  }

  openVacationDialog(day?: Date) {
    const selectedDay = day || new Date(this.currentMonth());
    this.vacationForm = {
      employeeId: '',
      replacementEmployeeId: '',
      startDate: new Date(selectedDay),
      endDate: this.addCalendarDays(selectedDay, 14),
      daysRequested: 15,
      reason: '',
      reorganize: true,
    };
    this.showVacationDialog = true;
  }

  generateRotation() {
    if (this.generation.employeeIds.length !== GUARDS_PER_ROTATION) {
      this.msg.add({
        severity: 'warn',
        summary: 'Selecciona cuatro guardias',
        detail: 'La rotación usa cuatro guardias: tres cubren turnos y uno descansa cada día.',
      });
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

  saveVacation() {
    if (!this.vacationForm.employeeId || !this.vacationForm.startDate || !this.vacationForm.daysRequested) {
      this.msg.add({ severity: 'warn', summary: 'Completa empleado, fecha inicial y días' });
      return;
    }
    const startDate = this.toIsoDate(this.vacationForm.startDate);
    const endDate = this.toIsoDate(this.vacationEndDate()!);
    if (this.vacationForm.reorganize && !this.vacationForm.replacementEmployeeId) {
      this.msg.add({ severity: 'warn', summary: 'Selecciona el reemplazo', detail: 'Elige quién cubrirá los turnos del guardia en vacaciones.' });
      return;
    }
    if (this.vacationForm.reorganize && this.vacationForm.replacementEmployeeId === this.vacationForm.employeeId) {
      this.msg.add({ severity: 'warn', summary: 'Reemplazo inválido', detail: 'El reemplazo debe ser distinto al guardia que sale de vacaciones.' });
      return;
    }

    this.saving.set(true);
    this.http.post<any>(`${environment.apiUrl}/shifts/vacations`, {
      employeeId: this.vacationForm.employeeId,
      replacementEmployeeId: this.vacationForm.reorganize ? this.vacationForm.replacementEmployeeId : undefined,
      startDate,
      endDate,
      daysRequested: this.vacationForm.daysRequested,
      reason: this.vacationForm.reason || undefined,
      reorganize: this.vacationForm.reorganize,
    }).subscribe({
      next: (response) => {
        this.saving.set(false);
        this.showVacationDialog = false;
        this.loadMonth();
        const reorg = response.data?.reorganization;
        this.msg.add({
          severity: 'success',
          summary: 'Vacaciones registradas',
          detail: reorg
            ? `Turnos afectados: ${reorg.affected}. Reasignados: ${reorg.reassigned}. Pendientes: ${reorg.unresolved}.`
            : undefined,
        });
      },
      error: (error) => {
        this.saving.set(false);
        this.msg.add({ severity: 'error', summary: 'No se registraron las vacaciones', detail: error.error?.message });
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

  monthTitle(date: Date): string {
    return new Intl.DateTimeFormat('es-EC', { month: 'long', year: 'numeric' }).format(date);
  }

  dayTitle(day: Date): string {
    const weekDay = new Intl.DateTimeFormat('es-EC', { weekday: 'short' }).format(day).replace('.', '');
    return `${weekDay} ${day.getDate()}`;
  }

  employeeName(assignment: Assignment): string { return `${assignment.first_name} ${assignment.last_name}`; }
  isToday(day: Date): boolean { return this.toIsoDate(day) === this.toIsoDate(new Date()); }
  shortTime(time: string): string { return String(time || '').slice(0, 5); }
  vacationName(vacation: VacationBlock): string { return `${vacation.firstName} ${vacation.lastName}`.trim(); }

  vacationsForDay(day: Date): VacationBlock[] {
    const date = this.toIsoDate(day);
    return this.vacations().filter((vacation) => vacation.startDate.slice(0, 10) <= date && vacation.endDate.slice(0, 10) >= date);
  }

  vacationTooltip(day: Date): string {
    return this.vacationsForDay(day).map((vacation) => this.vacationName(vacation)).join(', ');
  }

  isEmployeeOnVacation(employeeId: string, day: Date): boolean {
    const date = this.toIsoDate(day);
    return this.vacations().some((vacation) =>
      vacation.employeeId === employeeId &&
      vacation.startDate.slice(0, 10) <= date &&
      vacation.endDate.slice(0, 10) >= date
    );
  }

  availableGuardsForManual() {
    if (!this.manual.date) return this.guards();
    const date = this.toIsoDate(this.manual.date);
    return this.guards().filter((guard) => !this.vacations().some((vacation) =>
      vacation.employeeId === guard.value &&
      vacation.startDate.slice(0, 10) <= date &&
      vacation.endDate.slice(0, 10) >= date
    ));
  }

  onManualDateChanged() {
    if (!this.manual.employeeId) return;
    const stillAvailable = this.availableGuardsForManual().some((guard) => guard.value === this.manual.employeeId);
    if (!stillAvailable) this.manual.employeeId = '';
  }

  replacementGuardOptions() {
    return this.guards().filter((guard) => guard.value !== this.vacationForm.employeeId);
  }

  vacationEndDate(): Date | null {
    if (!this.vacationForm.startDate || !this.vacationForm.daysRequested) return null;
    return this.addCalendarDays(this.vacationForm.startDate, this.vacationForm.daysRequested - 1);
  }

  vacationReturnDate(): Date | null {
    const endDate = this.vacationEndDate();
    return endDate ? this.addCalendarDays(endDate, 1) : null;
  }

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

  private officialSchedule(role: RotationRole): string {
    if (role === 'rest') return 'Día libre';
    const meta = ROLE_META[role];
    return `${meta.startTime} – ${meta.endTime}`;
  }

  private roleForName(name: string): RotationRole | null {
    return (Object.keys(ROLE_META) as RotationRole[]).find((role) => this.matchesRole(name, role)) || null;
  }

  private withOfficialTimes<T extends { name?: string; shift_name?: string; start_time: string; end_time: string }>(item: T): T {
    const role = this.roleForName(item.name || item.shift_name || '');
    if (!role) return item;
    return {
      ...item,
      start_time: ROLE_META[role].startTime,
      end_time: ROLE_META[role].endTime,
    };
  }

  private firstDayOfMonth(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1); }

  private toIsoDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private addCalendarDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }
}
