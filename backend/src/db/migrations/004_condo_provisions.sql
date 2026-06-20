-- ============================================================
-- Migración 004 — Fondos de Reserva y Provisiones Financieras
-- Agrega políticas de provisión a condo_config,
-- columnas de provisión a condo_expense_periods,
-- y tabla de libro auxiliar de fondos (capital + incobrables).
-- Compatible con PostgreSQL 10+
-- ============================================================

-- ── 1. condo_config: porcentajes de política de provisión ───
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'condo_config'
      AND column_name = 'capital_reserve_pct'
  ) THEN
    ALTER TABLE condo_config
      ADD COLUMN capital_reserve_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'condo_config'
      AND column_name = 'bad_debt_pct'
  ) THEN
    ALTER TABLE condo_config
      ADD COLUMN bad_debt_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ── 2. condo_expense_periods: snapshot de provisiones ───────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'condo_expense_periods'
      AND column_name = 'capital_reserve'
  ) THEN
    ALTER TABLE condo_expense_periods
      ADD COLUMN capital_reserve NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'condo_expense_periods'
      AND column_name = 'bad_debt_provision'
  ) THEN
    ALTER TABLE condo_expense_periods
      ADD COLUMN bad_debt_provision NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'condo_expense_periods'
      AND column_name = 'total_provisions'
  ) THEN
    ALTER TABLE condo_expense_periods
      ADD COLUMN total_provisions NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'condo_expense_periods'
      AND column_name = 'grand_total'
  ) THEN
    ALTER TABLE condo_expense_periods
      ADD COLUMN grand_total NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ── 3. condo_fund_entries: libro auxiliar de fondos ─────────
CREATE TABLE IF NOT EXISTS condo_fund_entries (
  id             VARCHAR(36)   NOT NULL PRIMARY KEY,
  fund_type      VARCHAR(20)   NOT NULL
                   CHECK (fund_type IN ('CAPITAL_RESERVE', 'BAD_DEBT')),
  amount         NUMERIC(10,2) NOT NULL,
  -- positivo = entra al fondo  |  negativo = sale del fondo
  entry_type     VARCHAR(15)   NOT NULL
                   CHECK (entry_type IN ('PROVISION','EXPENDITURE','WRITE_OFF','ADJUSTMENT','REVERSAL')),
  period_id      VARCHAR(36)   REFERENCES condo_expense_periods(id) ON DELETE SET NULL,
  description    TEXT          NOT NULL,
  entry_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
  registered_by  VARCHAR(36)   REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE INDEX idx_condo_fund_entries_fund_type
    ON condo_fund_entries(fund_type);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX idx_condo_fund_entries_period
    ON condo_fund_entries(period_id);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX idx_condo_fund_entries_entry_date
    ON condo_fund_entries(entry_date DESC);
EXCEPTION WHEN OTHERS THEN NULL; END $$;
