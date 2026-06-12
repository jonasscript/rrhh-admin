require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const config  = require('./config/config');

const authRoutes         = require('./modules/auth/auth.routes');
const userRoutes         = require('./modules/users/user.routes');
const employeeRoutes     = require('./modules/employees/employee.routes');
const departmentRoutes   = require('./modules/employees/department.routes');
const payrollRoutes      = require('./modules/payroll/payroll.routes');
const vacationRoutes     = require('./modules/vacations/vacation.routes');
const shiftRoutes        = require('./modules/shifts/shift.routes');
const announcementRoutes = require('./modules/announcements/announcement.routes');
const condominiumRoutes  = require('./modules/condominium/condominium.routes');
const laborObligationsRoutes = require('./modules/labor-obligations/labor-obligations-global.routes');
const obligationCatalogRoutes = require('./modules/labor-obligations/obligation-catalog.routes');

const { errorMiddleware } = require('./middleware/error.middleware');

const app = express();

// ── Seguridad y parseo ────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (config.nodeEnv !== 'test') {
  app.use(morgan('dev'));
}

// ── Rutas ─────────────────────────────────────────────────────
const BASE = '/api/v1';

app.use(`${BASE}/auth`,          authRoutes);
app.use(`${BASE}/users`,         userRoutes);
app.use(`${BASE}/employees`,     employeeRoutes);
app.use(`${BASE}/departments`,   departmentRoutes);
app.use(`${BASE}/payroll`,       payrollRoutes);
app.use(`${BASE}/vacations`,     vacationRoutes);
app.use(`${BASE}/shifts`,        shiftRoutes);
app.use(`${BASE}/announcements`, announcementRoutes);
app.use(`${BASE}/condominium`,   condominiumRoutes);
app.use(`${BASE}/labor-obligations`, laborObligationsRoutes);
app.use(`${BASE}/obligation-catalog`, obligationCatalogRoutes);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── 404 ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Ruta no encontrada' }));

// ── Error handler global ──────────────────────────────────────
app.use(errorMiddleware);

module.exports = app;
