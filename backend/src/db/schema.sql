-- ============================================================
-- RRHH Admin + Condominio — PostgreSQL Schema v5
-- Idempotente: seguro para bases existentes o nuevas.
-- Compatible con PostgreSQL 13+
-- Los UUIDs son generados por el backend (VARCHAR 36)
-- Ejecutar: node src/db/migrate.js
--   o bien: psql -U <user> -d <database> -f schema.sql
-- ============================================================

-- ============================================================
-- TIPOS ENUMERADOS (idempotentes)
-- ============================================================

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('ADMIN','HR','SUPERVISOR','EMPLEADO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE contract_type AS ENUM ('INDEFINIDO','PLAZO_FIJO','OBRA_CIERTA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE employee_status AS ENUM ('ACTIVE','VACATION','INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE period_status AS ENUM ('DRAFT','APPROVED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE request_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE announcement_type AS ENUM ('INFO','URGENT','REMINDER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE announcement_status AS ENUM ('DRAFT','SCHEDULED','SENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE loan_status AS ENUM ('ACTIVE','PAID','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('PENDING','PARTIAL','PAID','OVERDUE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- FUNCIÓN TRIGGER updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- USUARIOS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id         VARCHAR(36)  NOT NULL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  role       user_role    NOT NULL DEFAULT 'EMPLEADO',
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- DEPARTAMENTOS
-- ============================================================

CREATE TABLE IF NOT EXISTS departments (
  id          VARCHAR(36)  NOT NULL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- EMPLEADOS
-- ============================================================

CREATE TABLE IF NOT EXISTS employees (
  id                 VARCHAR(36)     NOT NULL PRIMARY KEY,
  user_id            VARCHAR(36)     UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  department_id      VARCHAR(36)     REFERENCES departments(id) ON DELETE SET NULL,
  -- Datos personales
  first_name         VARCHAR(100)    NOT NULL,
  last_name          VARCHAR(100)    NOT NULL,
  cedula             VARCHAR(20)     NOT NULL UNIQUE,
  email              VARCHAR(255)    NOT NULL UNIQUE,
  phone              VARCHAR(20),
  address            TEXT,
  birth_date         DATE,
  -- Datos laborales
  position           VARCHAR(100)    NOT NULL,
  contract_type      contract_type   NOT NULL DEFAULT 'INDEFINIDO',
  start_date         DATE            NOT NULL,
  end_date           DATE,
  base_salary        NUMERIC(10,2)   NOT NULL,
  status             employee_status NOT NULL DEFAULT 'ACTIVE',
  -- Datos IESS
  iess_affiliate     BOOLEAN         NOT NULL DEFAULT TRUE,
  iess_quirografario NUMERIC(10,2)   NOT NULL DEFAULT 0,
  iess_hipotecario   NUMERIC(10,2)   NOT NULL DEFAULT 0,
  -- Datos bancarios
  bank_name          VARCHAR(100),
  bank_account       VARCHAR(50),
  -- Foto
  photo_url          TEXT,
  photo_public_id    TEXT,
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_status     ON employees(status);
CREATE INDEX IF NOT EXISTS idx_employees_cedula     ON employees(cedula);

DO $$ BEGIN
  CREATE TRIGGER trg_employees_updated_at
    BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- CATÁLOGO DE OBLIGACIONES LABORALES
-- ============================================================

CREATE TABLE IF NOT EXISTS obligation_catalog (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  code          VARCHAR(50)   NOT NULL UNIQUE,
  name          VARCHAR(100)  NOT NULL,
  description   TEXT,
  calc_type     VARCHAR(20)   NOT NULL CHECK (calc_type IN ('PERCENTAGE', 'FIXED')),
  default_value NUMERIC(10,4),
  payer         VARCHAR(20)   NOT NULL CHECK (payer IN ('EMPLOYER', 'EMPLOYEE')),
  recipient     VARCHAR(20)   NOT NULL CHECK (recipient IN ('IESS', 'EMPLOYEE', 'OTHER')),
  is_system     BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  display_order INT           NOT NULL DEFAULT 0,
  payment_mode  VARCHAR(20)   NOT NULL DEFAULT 'MONTHLY'
                  CHECK (payment_mode IN ('MONTHLY', 'LUMP_SUM')),
  payment_month SMALLINT      CHECK (payment_month BETWEEN 1 AND 12),
  payment_day   SMALLINT      CHECK (payment_day BETWEEN 1 AND 31),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER trg_obligation_catalog_updated_at
    BEFORE UPDATE ON obligation_catalog FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- OBLIGACIONES POR EMPLEADO
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_obligations (
  id             VARCHAR(36)   NOT NULL PRIMARY KEY,
  employee_id    VARCHAR(36)   NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  obligation_id  VARCHAR(36)   NOT NULL REFERENCES obligation_catalog(id) ON DELETE RESTRICT,
  is_active      BOOLEAN       NOT NULL DEFAULT TRUE,
  override_value NUMERIC(10,4),
  payout_mode    VARCHAR(20)   CONSTRAINT employee_obligations_payout_mode_check
                   CHECK (payout_mode IN ('IESS', 'EMPLOYEE', 'MONTHLY')),
  prefer_monthly BOOLEAN       NOT NULL DEFAULT FALSE,
  notes          TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, obligation_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_obligations_employee ON employee_obligations(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_obligations_catalog  ON employee_obligations(obligation_id);

DO $$ BEGIN
  CREATE TRIGGER trg_employee_obligations_updated_at
    BEFORE UPDATE ON employee_obligations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- PERÍODOS DE NÓMINA
-- ============================================================

CREATE TABLE IF NOT EXISTS payroll_periods (
  id         VARCHAR(36)   NOT NULL PRIMARY KEY,
  month      SMALLINT      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year       SMALLINT      NOT NULL CHECK (year >= 2000),
  status     period_status NOT NULL DEFAULT 'DRAFT',
  created_by VARCHAR(36)   REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (month, year)
);

DO $$ BEGIN
  CREATE TRIGGER trg_payroll_periods_updated_at
    BEFORE UPDATE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- DETALLE DE NÓMINA POR EMPLEADO
-- ============================================================

CREATE TABLE IF NOT EXISTS payroll_details (
  id                  VARCHAR(36)   NOT NULL PRIMARY KEY,
  period_id           VARCHAR(36)   NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id         VARCHAR(36)   NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- Ingresos base
  base_salary         NUMERIC(10,2) NOT NULL,
  worked_days         SMALLINT      NOT NULL DEFAULT 30,
  -- Horas extras
  overtime_supp_hours NUMERIC(5,2)  NOT NULL DEFAULT 0,  -- suplementarias +50%
  overtime_extr_hours NUMERIC(5,2)  NOT NULL DEFAULT 0,  -- extraordinarias +100%
  overtime_pay        NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Beneficios
  decimo_tercero      NUMERIC(10,2) NOT NULL DEFAULT 0,
  decimo_cuarto       NUMERIC(10,2) NOT NULL DEFAULT 0,
  fondos_reserva      NUMERIC(10,2) NOT NULL DEFAULT 0,
  fondos_payout_mode  VARCHAR(10)   NOT NULL DEFAULT 'MONTHLY'
                        CHECK (fondos_payout_mode IN ('MONTHLY', 'IESS')),
  -- Descuentos
  iess_employee       NUMERIC(10,2) NOT NULL DEFAULT 0,  -- 9.45%
  iess_employer       NUMERIC(10,2) NOT NULL DEFAULT 0,  -- 11.15%
  loan_discount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  iess_loans          NUMERIC(10,2) NOT NULL DEFAULT 0,  -- quirografario + hipotecario
  other_discounts     NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Totales
  gross_pay           NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_pay             NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Notas
  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_details_period   ON payroll_details(period_id);
CREATE INDEX IF NOT EXISTS idx_payroll_details_employee ON payroll_details(employee_id);

DO $$ BEGIN
  CREATE TRIGGER trg_payroll_details_updated_at
    BEFORE UPDATE ON payroll_details FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- HISTORIAL DE PAGOS DE OBLIGACIONES POR NÓMINA
-- ============================================================

CREATE TABLE IF NOT EXISTS obligation_payment_records (
  id                 VARCHAR(36)   NOT NULL PRIMARY KEY,
  employee_id        VARCHAR(36)   NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  obligation_id      VARCHAR(36)   NOT NULL REFERENCES obligation_catalog(id),
  payroll_period_id  VARCHAR(36)   NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  period_month       SMALLINT      NOT NULL,
  period_year        SMALLINT      NOT NULL,
  installment_num    SMALLINT      NOT NULL,
  total_installments SMALLINT      NOT NULL DEFAULT 12,
  amount             NUMERIC(10,2) NOT NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, obligation_id, payroll_period_id)
);

CREATE INDEX IF NOT EXISTS idx_obl_pmt_records_employee ON obligation_payment_records(employee_id);
CREATE INDEX IF NOT EXISTS idx_obl_pmt_records_period   ON obligation_payment_records(payroll_period_id);

-- ============================================================
-- SALDO DE VACACIONES
-- ============================================================

CREATE TABLE IF NOT EXISTS vacation_balances (
  id                VARCHAR(36)  NOT NULL PRIMARY KEY,
  employee_id       VARCHAR(36)  NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  available_days    NUMERIC(5,2) NOT NULL DEFAULT 0,
  used_days         NUMERIC(5,2) NOT NULL DEFAULT 0,
  accrued_days      NUMERIC(5,2) NOT NULL DEFAULT 0,
  last_accrual_date DATE,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SOLICITUDES DE VACACIONES
-- ============================================================

CREATE TABLE IF NOT EXISTS vacation_requests (
  id             VARCHAR(36)    NOT NULL PRIMARY KEY,
  employee_id    VARCHAR(36)    NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_date     DATE           NOT NULL,
  end_date       DATE           NOT NULL,
  days_requested NUMERIC(5,2)   NOT NULL,
  status         request_status NOT NULL DEFAULT 'PENDING',
  reason         TEXT,
  reviewed_by    VARCHAR(36)    REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  review_notes   TEXT,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vacation_requests_employee ON vacation_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_vacation_requests_status   ON vacation_requests(status);

DO $$ BEGIN
  CREATE TRIGGER trg_vacation_requests_updated_at
    BEFORE UPDATE ON vacation_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- PLANTILLAS DE TURNO
-- ============================================================

CREATE TABLE IF NOT EXISTS shift_templates (
  id         VARCHAR(36)  NOT NULL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  start_time TIME         NOT NULL,
  end_time   TIME         NOT NULL,
  color      VARCHAR(20)  NOT NULL DEFAULT '#3B82F6',
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ASIGNACIONES DE TURNO
-- ============================================================

CREATE TABLE IF NOT EXISTS shift_assignments (
  id                VARCHAR(36)  NOT NULL PRIMARY KEY,
  employee_id       VARCHAR(36)  NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_template_id VARCHAR(36)  NOT NULL REFERENCES shift_templates(id) ON DELETE CASCADE,
  date              DATE         NOT NULL,
  notes             TEXT,
  created_by        VARCHAR(36)  REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

CREATE INDEX IF NOT EXISTS idx_shift_assignments_employee ON shift_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_shift_assignments_date     ON shift_assignments(date);

-- ============================================================
-- PRÉSTAMOS
-- ============================================================

CREATE TABLE IF NOT EXISTS loans (
  id               VARCHAR(36)   NOT NULL PRIMARY KEY,
  employee_id      VARCHAR(36)   NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  amount           NUMERIC(10,2) NOT NULL,
  monthly_discount NUMERIC(10,2) NOT NULL,
  balance          NUMERIC(10,2) NOT NULL,
  status           loan_status   NOT NULL DEFAULT 'ACTIVE',
  start_date       DATE          NOT NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loans_employee ON loans(employee_id);
CREATE INDEX IF NOT EXISTS idx_loans_status   ON loans(status);

DO $$ BEGIN
  CREATE TRIGGER trg_loans_updated_at
    BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- COMUNICADOS / ANUNCIOS
-- ============================================================

CREATE TABLE IF NOT EXISTS announcements (
  id           VARCHAR(36)         NOT NULL PRIMARY KEY,
  title        VARCHAR(255)        NOT NULL,
  body         TEXT                NOT NULL,
  type         announcement_type   NOT NULL DEFAULT 'INFO',
  status       announcement_status NOT NULL DEFAULT 'DRAFT',
  send_email   BOOLEAN             NOT NULL DEFAULT FALSE,
  target_all   BOOLEAN             NOT NULL DEFAULT TRUE,
  scheduled_at TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  created_by   VARCHAR(36)         REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

-- Destinatarios específicos (cuando target_all = false)
CREATE TABLE IF NOT EXISTS announcement_recipients (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  announcement_id VARCHAR(36) NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  employee_id     VARCHAR(36) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE (announcement_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_announcements_status    ON announcements(status);
CREATE INDEX IF NOT EXISTS idx_announcements_scheduled ON announcements(scheduled_at) WHERE status = 'SCHEDULED';

DO $$ BEGIN
  CREATE TRIGGER trg_announcements_updated_at
    BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- CONDOMINIO — CONFIGURACIÓN
-- ============================================================

CREATE TABLE IF NOT EXISTS condo_config (
  id                VARCHAR(36)   NOT NULL PRIMARY KEY,
  name              VARCHAR(200)  NOT NULL DEFAULT 'Condominio',
  admin_email       VARCHAR(255),
  fixed_maintenance NUMERIC(10,2) NOT NULL DEFAULT 0,
  fixed_security    NUMERIC(10,2) NOT NULL DEFAULT 0,
  fixed_cleaning    NUMERIC(10,2) NOT NULL DEFAULT 0,
  fixed_other       NUMERIC(10,2) NOT NULL DEFAULT 0,
  mora_enabled      BOOLEAN       NOT NULL DEFAULT TRUE,
  mora_rate         NUMERIC(5,4)  NOT NULL DEFAULT 0.02,  -- porcentaje mensual (ej: 0.02 = 2%)
  mora_grace_days   SMALLINT      NOT NULL DEFAULT 5,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER trg_condo_config_updated_at
    BEFORE UPDATE ON condo_config FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- CONDOMINIO — CO-PROPIETARIOS
-- ============================================================

CREATE TABLE IF NOT EXISTS condo_owners (
  id                VARCHAR(36)   NOT NULL PRIMARY KEY,
  name              VARCHAR(200)  NOT NULL,
  email             VARCHAR(255),
  phone             VARCHAR(30),
  unit_number       VARCHAR(20)   NOT NULL UNIQUE,
  participation_pct NUMERIC(6,4)  NOT NULL DEFAULT 0,   -- ej: 10.5000 = 10.5%
  mora_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER trg_condo_owners_updated_at
    BEFORE UPDATE ON condo_owners FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- CONDOMINIO — PERÍODOS DE GASTO
-- ============================================================

CREATE TABLE IF NOT EXISTS condo_expense_periods (
  id                VARCHAR(36)   NOT NULL PRIMARY KEY,
  month             SMALLINT      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year              SMALLINT      NOT NULL CHECK (year >= 2000),
  fixed_maintenance NUMERIC(10,2) NOT NULL DEFAULT 0,
  fixed_security    NUMERIC(10,2) NOT NULL DEFAULT 0,
  fixed_cleaning    NUMERIC(10,2) NOT NULL DEFAULT 0,
  fixed_other       NUMERIC(10,2) NOT NULL DEFAULT 0,
  variable_expenses NUMERIC(10,2) NOT NULL DEFAULT 0,
  variable_notes    TEXT,
  total_expenses    NUMERIC(10,2) NOT NULL DEFAULT 0,
  status            period_status NOT NULL DEFAULT 'DRAFT',
  notes             TEXT,
  generated_at      TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  created_by        VARCHAR(36)   REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (month, year)
);

DO $$ BEGIN
  CREATE TRIGGER trg_condo_expense_periods_updated_at
    BEFORE UPDATE ON condo_expense_periods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- CONDOMINIO — PAGOS DE ALÍCUOTA
-- ============================================================

CREATE TABLE IF NOT EXISTS aliquot_payments (
  id                VARCHAR(36)    NOT NULL PRIMARY KEY,
  period_id         VARCHAR(36)    NOT NULL REFERENCES condo_expense_periods(id) ON DELETE CASCADE,
  owner_id          VARCHAR(36)    NOT NULL REFERENCES condo_owners(id) ON DELETE CASCADE,
  aliquot_amount    NUMERIC(10,2)  NOT NULL,
  mora_at_billing   NUMERIC(10,2)  NOT NULL DEFAULT 0,
  paid_amount       NUMERIC(10,2)  NOT NULL DEFAULT 0,
  payment_date      DATE,
  status            payment_status NOT NULL DEFAULT 'PENDING',
  proof_url         TEXT,
  proof_public_id   TEXT,
  proof_uploaded_at TIMESTAMPTZ,
  notes             TEXT,
  registered_by     VARCHAR(36)    REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_aliquot_payments_period ON aliquot_payments(period_id);
CREATE INDEX IF NOT EXISTS idx_aliquot_payments_owner  ON aliquot_payments(owner_id);
CREATE INDEX IF NOT EXISTS idx_aliquot_payments_status ON aliquot_payments(status);

DO $$ BEGIN
  CREATE TRIGGER trg_aliquot_payments_updated_at
    BEFORE UPDATE ON aliquot_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- MIGRACIONES INCREMENTALES (idempotentes)
-- Se ejecutan en bases existentes para añadir columnas/tablas
-- nuevas sin tocar datos. En instalaciones frescas los IF NOT
-- EXISTS no encuentran nada y el bloque termina en un no-op.
-- ============================================================
DO $$
DECLARE
  v_fondo_id VARCHAR(36) := 'a0000003-0000-0000-0000-000000000003';
  v_quiro_id VARCHAR(36) := 'a0000004-0000-0000-0000-000000000004';
  v_hipo_id  VARCHAR(36) := 'a0000005-0000-0000-0000-000000000005';
BEGIN
  -- ── employees: columnas IESS (v2) ───────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'employees'
      AND column_name = 'iess_quirografario'
  ) THEN
    ALTER TABLE employees
      ADD COLUMN iess_quirografario NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'employees'
      AND column_name = 'iess_hipotecario'
  ) THEN
    ALTER TABLE employees
      ADD COLUMN iess_hipotecario NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;

  -- ── payroll_details: iess_loans (v2) ────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payroll_details'
      AND column_name = 'iess_loans'
  ) THEN
    ALTER TABLE payroll_details
      ADD COLUMN iess_loans NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;

  -- ── payroll_details: fondos_payout_mode (v4) ────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payroll_details'
      AND column_name = 'fondos_payout_mode'
  ) THEN
    ALTER TABLE payroll_details
      ADD COLUMN fondos_payout_mode VARCHAR(10) NOT NULL DEFAULT 'MONTHLY'
        CHECK (fondos_payout_mode IN ('MONTHLY', 'IESS'));
  END IF;

  -- ── condo_expense_periods: variable_notes (v2) ──────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'condo_expense_periods'
      AND column_name = 'variable_notes'
  ) THEN
    ALTER TABLE condo_expense_periods ADD COLUMN variable_notes TEXT;
  END IF;

  -- ── obligation_catalog: payment_mode (v4) ───────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'obligation_catalog'
      AND column_name = 'payment_mode'
  ) THEN
    ALTER TABLE obligation_catalog
      ADD COLUMN payment_mode VARCHAR(20) NOT NULL DEFAULT 'MONTHLY'
        CHECK (payment_mode IN ('MONTHLY', 'LUMP_SUM'));
  END IF;

  -- ── obligation_catalog: payment_month (v4) ──────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'obligation_catalog'
      AND column_name = 'payment_month'
  ) THEN
    ALTER TABLE obligation_catalog
      ADD COLUMN payment_month SMALLINT CHECK (payment_month BETWEEN 1 AND 12);
  END IF;

  -- ── obligation_catalog: payment_day (v5) ────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'obligation_catalog'
      AND column_name = 'payment_day'
  ) THEN
    ALTER TABLE obligation_catalog
      ADD COLUMN payment_day SMALLINT CHECK (payment_day BETWEEN 1 AND 31);
  END IF;

  -- ── employee_obligations: payout_mode constraint (v4) ───────
  -- Actualiza el CHECK para admitir 'MONTHLY' en bases existentes.
  ALTER TABLE employee_obligations
    DROP CONSTRAINT IF EXISTS employee_obligations_payout_mode_check;
  ALTER TABLE employee_obligations
    ADD CONSTRAINT employee_obligations_payout_mode_check
      CHECK (payout_mode IN ('IESS', 'EMPLOYEE', 'MONTHLY'));

  -- ── employee_obligations: prefer_monthly (v5) ───────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'employee_obligations'
      AND column_name = 'prefer_monthly'
  ) THEN
    ALTER TABLE employee_obligations
      ADD COLUMN prefer_monthly BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  -- ── Migrar employee_labor_obligations → employee_obligations ─
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'employee_labor_obligations'
  ) THEN
    -- Fondo de reserva
    INSERT INTO employee_obligations
      (id, employee_id, obligation_id, is_active, payout_mode)
    SELECT SUBSTRING(MD5(employee_id || v_fondo_id) FROM 1 FOR 36),
           employee_id, v_fondo_id, fondos_reserva_aplica, 'IESS'
    FROM employee_labor_obligations
    ON CONFLICT (employee_id, obligation_id) DO NOTHING;
    -- Préstamo quirografario
    INSERT INTO employee_obligations
      (id, employee_id, obligation_id, is_active, override_value)
    SELECT SUBSTRING(MD5(employee_id || v_quiro_id) FROM 1 FOR 36),
           employee_id, v_quiro_id, TRUE, iess_quirografario
    FROM employee_labor_obligations WHERE iess_quirografario > 0
    ON CONFLICT (employee_id, obligation_id) DO NOTHING;
    -- Préstamo hipotecario
    INSERT INTO employee_obligations
      (id, employee_id, obligation_id, is_active, override_value)
    SELECT SUBSTRING(MD5(employee_id || v_hipo_id) FROM 1 FOR 36),
           employee_id, v_hipo_id, TRUE, iess_hipotecario
    FROM employee_labor_obligations WHERE iess_hipotecario > 0
    ON CONFLICT (employee_id, obligation_id) DO NOTHING;
    DROP TABLE employee_labor_obligations;
  END IF;

END $$;

-- ============================================================
-- SEMILLA — CATÁLOGO DE OBLIGACIONES BASE
-- ============================================================

INSERT INTO obligation_catalog
  (id, code, name, description, calc_type, default_value, payer, recipient,
   is_system, is_active, display_order, payment_mode, payment_month, payment_day)
VALUES
  ('a0000001-0000-0000-0000-000000000001', 'IESS_EMPLOYEE',
   'Aporte IESS Empleado',
   'Aporte personal obligatorio — 9.45% del sueldo imponible',
   'PERCENTAGE', 0.0945, 'EMPLOYEE', 'IESS', TRUE, TRUE, 1, 'MONTHLY', NULL, NULL),

  ('a0000002-0000-0000-0000-000000000002', 'IESS_EMPLOYER',
   'Aporte Patronal IESS',
   'Aporte patronal obligatorio — 11.15% del sueldo imponible',
   'PERCENTAGE', 0.1115, 'EMPLOYER', 'IESS', TRUE, TRUE, 2, 'MONTHLY', NULL, NULL),

  ('a0000003-0000-0000-0000-000000000003', 'FONDO_RESERVA',
   'Fondo de Reserva',
   'Fondo de reserva patronal — 8.33% del salario mensual (desde mes 13)',
   'PERCENTAGE', 0.0833, 'EMPLOYER', 'IESS', TRUE, TRUE, 3, 'MONTHLY', NULL, NULL),

  ('a0000004-0000-0000-0000-000000000004', 'IESS_QUIROGRAFARIO',
   'Préstamo Quirografario IESS',
   'Descuento mensual por préstamo quirografario IESS',
   'FIXED', NULL, 'EMPLOYEE', 'IESS', FALSE, TRUE, 4, 'MONTHLY', NULL, NULL),

  ('a0000005-0000-0000-0000-000000000005', 'IESS_HIPOTECARIO',
   'Préstamo Hipotecario IESS',
   'Descuento mensual por préstamo hipotecario IESS',
   'FIXED', NULL, 'EMPLOYEE', 'IESS', FALSE, TRUE, 5, 'MONTHLY', NULL, NULL),

  ('a0000006-0000-0000-0000-000000000006', 'DECIMO_TERCERO',
   'Décimo Tercero',
   'Decimotercer sueldo — 1/12 del salario mensual (provisión mensual obligatoria)',
   'PERCENTAGE', 0.0833, 'EMPLOYER', 'EMPLOYEE', TRUE, TRUE, 6, 'MONTHLY', NULL, NULL),

  ('a0000007-0000-0000-0000-000000000007', 'DECIMO_CUARTO',
   'Décimo Cuarto',
   'Decimocuarto sueldo — 1/12 del SBU vigente (provisión mensual; ajustar default_value = SBU/12)',
   'FIXED', 38.33, 'EMPLOYER', 'EMPLOYEE', TRUE, TRUE, 7, 'MONTHLY', NULL, NULL)
ON CONFLICT (code) DO NOTHING;
