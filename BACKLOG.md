# HABBITA — Backlog

> Fecha de análisis: 12 de junio de 2026

---

## Estado general por módulo

| Módulo | Backend | Frontend | Notas |
|---|---|---|---|
| **Auth** | ✅ Completo | ✅ Completo | Login, JWT, cambio de contraseña |
| **Empleados** | ✅ Completo | ✅ Completo | CRUD + departamentos + foto |
| **Nómina** | ✅ Completo | ✅ Completo | Motor de cálculo complejo + PDF |
| **Vacaciones** | ✅ Completo | ✅ Completo | Solicitudes, aprobación, saldo |
| **Turnos** | ✅ Completo | ✅ Completo | Plantillas + calendario |
| **Comunicados** | ✅ Completo | ✅ Completo | Agenda, email, destinatarios |
| **Obligaciones laborales** | ✅ Completo | ✅ Completo | Catálogo + config por empleado |
| **Condo · Config** | ✅ Completo | ✅ Completo | Gastos fijos, mora |
| **Condo · Propietarios** | ✅ Completo | ✅ Completo | CRUD, mora, importar Excel |
| **Condo · Períodos** | ✅ Completo | ⚠️ Parcial | Scaffolded sin lógica real |
| **Condo · Pagos alícuota** | ✅ Completo | ⚠️ Parcial | Sin UI de registro/comprobante |
| **Condo · Morosidad** | ✅ Completo | ⚠️ Parcial | Scaffolded |
| **Condo · Dashboard** | N/A | ❌ Vacío | Componente sin contenido |
| **Dashboard principal** | N/A | ❌ Scaffolded | 4 tarjetas mostrando "—" |
| **Gestión de usuarios** | ✅ Completo | ❌ Faltante | Sin ningún componente frontend |
| **Perfil / Mi cuenta** | ✅ Parcial | ❌ Faltante | Endpoint existe, sin UI |
| **Préstamos** | ❌ Faltante | ❌ Faltante | Solo tabla en BD |
| **Cron jobs** | ✅ Completo | N/A | Comunicados, mora, recordatorios |
| **Servicios** | ✅ Completo | N/A | Email, PDF, Cloudinary, upload |

---

## Análisis detallado por módulo

### Auth
**Backend** — `auth.controller.js`, `auth.routes.js`
- `POST /auth/login` — JWT con bcrypt ✅
- `GET /auth/me` — retorna user + datos de empleado ✅
- `PATCH /auth/change-password` — reset de contraseña ✅

**Frontend** — `LoginComponent`
- Formulario reactivo con validación ✅
- Token guardado en localStorage ✅
- Redirección a `/dashboard` al autenticar ✅

---

### Empleados
**Backend** — `employee.controller.js`, `employee.routes.js`, `department.routes.js`
- `GET /employees` — lista paginada con búsqueda, filtros y join de departamento ✅
- `GET /employees/:id` — detalle ✅
- `POST /employees` — creación con usuario opcional, transacción ✅
- `PUT /employees/:id` — actualización completa ✅
- `DELETE /employees/:id` — eliminación ✅
- `GET /departments` — con conteo de empleados ✅
- `POST/PUT /departments` — validación Zod ✅
- `DELETE /departments/:id` — con cascade a empleados ✅

**Frontend** — `EmployeeListComponent`, `EmployeeDetailComponent`, `EmployeeFormComponent`
- Lista paginada con filtros de estado y departamento ✅
- Formulario completo (datos personales, laborales, IESS, bancarios) ✅
- Vista detalle con tabs: info, nóminas, obligaciones ✅

---

### Nómina
**Backend** — `payroll.controller.js`, `payroll.routes.js`, `payroll.calculator.js`
- `GET /payroll/periods` — paginado con agregados ✅
- `POST /payroll/periods` — restricción: solo mes actual, sin períodos abiertos ✅
- `GET /payroll/periods/:id` — con conteo y totales ✅
- `GET /payroll/periods/:id/details` — desglose completo con resumen ✅
- `POST /payroll/periods/:id/generate` — calcula nómina para todos los empleados activos ✅
- `PUT /payroll/periods/:id/details/:employeeId` — edición individual ✅
- `POST /payroll/periods/:id/close` — cierre del período ✅
- `GET /payroll/details/:id/pdf` — generación de PDF ✅

Motor de cálculo: horas extras, IESS 9.45%, Décimo Tercero, Décimo Cuarto, Fondos de Reserva, aporte patronal 11.15%.

**Frontend** — `PayrollListComponent`, `PayrollDetailComponent`
- Lista de períodos con estado, conteo de empleados, total neto ✅
- Tabla de desglose: nombre, cédula, cargo, bruto, IESS, neto, costo empleador ✅
- Botones: generar nómina, cerrar período, descargar PDF por empleado ✅

---

### Obligaciones Laborales
**Backend** — `labor-obligations.controller.js`, `obligation-catalog.routes.js`, `labor-obligations-global.routes.js`
- `GET /labor-obligations` — lista empleados con detalle de obligaciones ✅
- `GET /labor-obligations/payment-records` — historial de pagos ✅
- `GET /employees/:id/labor-obligations` — obligaciones del empleado ✅
- `PUT /employees/:id/labor-obligations` — upsert de obligaciones ✅
- `GET/POST/PUT/DELETE /obligation-catalog` — CRUD del catálogo ✅

Cálculo: PERCENTAGE vs FIXED, payer EMPLOYER/EMPLOYEE, modos IESS vs MONTHLY para Fondo de Reserva, valores override por empleado.

**Frontend** — `LaborObligationsListComponent`
- Tabla grande con datos de empleado + columnas de obligaciones ✅
- Diálogo de edición con controles por obligación (is_active, override_value, payout_mode) ✅
- Estadísticas calculadas: costo patronal mensual, deducciones empleado, total IESS ✅

---

### Vacaciones
**Backend** — `vacation.routes.js`
- `GET /vacations/requests` — paginado, filtrable por status/empleado ✅
- `GET /vacations/balance/:employeeId` — saldo disponible ✅
- `POST /vacations/requests` — valida días disponibles ✅
- `PATCH /vacations/requests/:id/review` — aprobación/rechazo con transacción y actualización de saldo ✅

**Frontend** — `VacationListComponent`
- Tabla de solicitudes con filtro por estado ✅
- Diálogo de revisión con botones APROBADO/RECHAZADO ✅

---

### Turnos
**Backend** — `shift.routes.js`
- `GET/POST /shifts/templates` — plantillas con validación de horario ✅
- `PUT /shifts/templates/:id` — actualización parcial ✅
- `GET /shifts/assignments` — filtrable por rango de fechas y empleado ✅
- `POST /shifts/assignments` — asignación de turno ✅

**Frontend** — `ShiftCalendarComponent`
- Vista semanal (Lun–Dom) en grilla empleados × días ✅
- Colores por plantilla de turno ✅
- Navegación anterior/siguiente/hoy ✅
- Dropdowns de empleado y plantilla ✅

---

### Comunicados
**Backend** — `announcement.routes.js`
- `GET /announcements` — paginado, filtrable por status ✅
- `GET /announcements/:id` — detalle ✅
- `POST /announcements` — con soporte DRAFT/SCHEDULED y selección de destinatarios ✅
- `POST /announcements/:id/send` — envío inmediato ✅
- `DELETE /announcements/:id` ✅

**Frontend** — `AnnouncementListComponent`, `AnnouncementFormComponent`
- Tabla con filtro por estado ✅
- Formulario: título, cuerpo, tipo, envío email, todos vs. destinatarios específicos, fecha programada ✅
- Botones de enviar/eliminar con confirmación ✅

---

### Condominio · Config
**Backend** — `condominium.routes.js`
- `GET /condominium/config` ✅
- `PUT /condominium/config` — gastos fijos, configuración de mora ✅

**Frontend** — `CondoConfigComponent`
- Formulario: nombre, email admin, gastos fijos por categoría, tasa de mora, días de gracia ✅

---

### Condominio · Propietarios
**Backend**
- `GET /condominium/owners` ✅
- `POST /condominium/owners` ✅
- `PUT /condominium/owners/:id` ✅
- `PATCH /condominium/owners/:id/mora` — ajuste de mora (ADD/SUBTRACT/SET) ✅
- `POST /condominium/owners/import` — importación Excel con validación de errores ✅

**Frontend** — `CondoOwnersComponent`
- Tabla: unidad, nombre, email, teléfono, % participación, mora ✅
- Diálogos: crear/editar propietario, ajustar mora ✅
- Importación Excel con reporte de errores ✅

---

### Servicios de infraestructura (Backend)
- **`email.service.js`** — Nodemailer para comunicados, alícuotas, nómina ✅
- **`pdf.service.js`** — PDFKit para recibos de nómina y pagos de alícuota ✅
- **`upload.service.js`** — Multer (5 MB, JPEG/PNG/WEBP/PDF) ✅
- **`cloudinary.service.js`** — Fotos de empleados y comprobantes ✅
- **`auth.middleware.js`** — Verificación JWT + autorización por roles ✅
- **`error.middleware.js`** — Zod, PostgreSQL constraints, AppError ✅

### Cron Jobs (Backend)
- Envío de comunicados programados — cada minuto ✅
- Recordatorio de alícuotas — día 5 de cada mes, 8 am ✅
- Actualización de mora — todos los lunes, 7 am ✅

---

## ❌ Faltante / Solo scaffolded

| Área | Detalle |
|---|---|
| **Dashboard principal** | Componente con 4 tarjetas pero todas muestran "—". Sin llamadas HTTP ni lógica implementada |
| **Condo · Períodos de gasto** | Backend completo. Frontend scaffolded: falta UI para crear período, ver alícuotas, cerrar período |
| **Condo · Pagos de alícuota** | Backend completo. Frontend scaffolded: falta UI de registro de pago y subida de comprobante |
| **Condo · Morosidad** | Reporte backend existe. Frontend scaffolded sin tabla de datos |
| **Condo · Dashboard** | Componente vacío, sin ninguna estadística |
| **Gestión de usuarios** | Backend 100% completo. Sin ningún componente frontend (lista, formulario, reset password) |
| **Perfil / Mi cuenta** | Endpoint `PATCH /auth/change-password` existe. Sin UI en el sidebar |
| **Préstamos** | Tabla `loans` en BD (monto, descuento mensual, saldo, estado). Sin backend routes ni frontend |

---

## 📋 Backlog de trabajo pendiente

### 🔴 Alta prioridad

- [ ] **Dashboard principal** — Conectar las 4 tarjetas: empleados activos, nómina del mes, vacaciones pendientes, propietarios morosos. Requiere endpoint de estadísticas en backend
- [ ] **Condo · Períodos de gasto (frontend)** — Crear período, listar alícuotas generadas por propietario con estado PENDING/PAID, cerrar período
- [ ] **Condo · Pagos de alícuota (frontend)** — Registrar pago (monto + fecha), subir comprobante (Cloudinary), ver estado por propietario en el período
- [ ] **Condo · Reporte de morosidad (frontend)** — Tabla de propietarios con mora acumulada, días de retraso y estado de pago del período actual
- [ ] **Gestión de usuarios (frontend)** — Lista de usuarios con filtro por rol, formulario crear/editar, activar/desactivar, reset de contraseña

### 🟡 Media prioridad

- [ ] **Condo · Dashboard (frontend)** — Cards: total cobrado en el período activo, saldo pendiente, mora total acumulada, alícuota promedio por unidad
- [ ] **Perfil / Mi cuenta (frontend)** — Formulario accesible desde el sidebar para cambiar la contraseña del usuario autenticado
- [ ] **Reporte de nómina exportable** — Exportar resumen del período completo en PDF o Excel con todos los empleados y sus totales
- [ ] **Vista del propietario** — Acceso de solo lectura para propietarios (nuevo rol) para consultar sus estados de cuenta y alícuotas

### 🟢 Baja prioridad / Futuro

- [ ] **Módulo de préstamos** — Backend routes (CRUD, amortización) + UI frontend para gestionar préstamos de empleados. Tabla `loans` ya existe en BD
- [ ] **Notificaciones in-app** — Alertas en la UI para vacaciones pendientes, períodos abiertos, alícuotas vencidas (actualmente solo por email)
- [ ] **Exportar historial de vacaciones** — Reporte Excel por empleado o global: días usados, saldo disponible, historial de solicitudes
- [ ] **Exportar asignaciones de turnos** — Vista imprimible / exportable del calendario semanal o mensual
- [ ] **Acumulación automática de vacaciones** — Cron job mensual que acredite días según antigüedad. La tabla `vacation_balances` ya tiene los campos `accrued_days` y `last_accrual_date`
- [ ] **Historial de auditoría** — Registro de cambios críticos (modificaciones de nómina, cambios de rol, ajustes de mora)
