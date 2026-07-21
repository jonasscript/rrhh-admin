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
app.use(helmet({ referrerPolicy: false }));
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (config.nodeEnv !== 'test') {
  app.use(morgan('dev'));
}

// ── Rutas ─────────────────────────────────────────────────────
const registerApiRoutes = (base) => {
  app.use(`${base}/auth`,          authRoutes);
  app.use(`${base}/users`,         userRoutes);
  app.use(`${base}/employees`,     employeeRoutes);
  app.use(`${base}/departments`,   departmentRoutes);
  app.use(`${base}/payroll`,       payrollRoutes);
  app.use(`${base}/vacations`,     vacationRoutes);
  app.use(`${base}/shifts`,        shiftRoutes);
  app.use(`${base}/announcements`, announcementRoutes);
  app.use(`${base}/condominium`,   condominiumRoutes);
  app.use(`${base}/labor-obligations`, laborObligationsRoutes);
  app.use(`${base}/obligation-catalog`, obligationCatalogRoutes);
};

registerApiRoutes('/api/v1');
registerApiRoutes('/habbita-api/api/v1');
registerApiRoutes('/habbita-api');
// registerApiRoutes('/porton_del_rio_api/api/v1');
// registerApiRoutes('/porton_del_rio_api');
registerApiRoutes('');

// ── Health check ──────────────────────────────────────────────
app.get([
  '/',
  '/health',
  '/api/v1',
  '/habbita-api',
  '/habbita-api/',
  '/habbita-api/health',
  '/habbita-api/api/v1',
  '/habbita-api/api/v1/health',
  // '/porton_del_rio_api',
  // '/porton_del_rio_api/',
  // '/porton_del_rio_api/health',
  // '/porton_del_rio_api/api/v1',
  // '/porton_del_rio_api/api/v1/health',
// ], (_req, res) => res.json({ status: 'ok', name: 'PORTON DEL RIO API' }));
], (_req, res) => res.json({ status: 'ok', name: 'PORTON DEL RIO API' }));

// ── 404 ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Ruta no encontrada' }));

// ── Error handler global ──────────────────────────────────────
app.use(errorMiddleware);

module.exports = app;
