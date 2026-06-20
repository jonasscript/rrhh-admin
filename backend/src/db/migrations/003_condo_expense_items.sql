-- ============================================================
-- Migración 003 — Ítems de gastos del condominio
-- Permite configurar gastos fijos y variables por categoría
-- que se usan como base para calcular las alícuotas.
-- ============================================================

-- Catálogo de ítems de gasto del condominio
CREATE TABLE IF NOT EXISTS condo_expense_items (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  name          VARCHAR(200)  NOT NULL,
  description   TEXT,
  category      VARCHAR(50)   NOT NULL DEFAULT 'OTHER'
                  CHECK (category IN ('MAINTENANCE','SECURITY','CLEANING','UTILITIES','ADMINISTRATION','OTHER')),
  expense_type  VARCHAR(10)   NOT NULL CHECK (expense_type IN ('FIXED','VARIABLE')),
  amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  is_recurring  BOOLEAN       NOT NULL DEFAULT TRUE,
  display_order INT           NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER trg_condo_expense_items_updated_at
    BEFORE UPDATE ON condo_expense_items FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ítems de gasto por período (snapshot de lo usado para calcular alícuotas)
CREATE TABLE IF NOT EXISTS condo_period_expense_items (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  period_id       VARCHAR(36)   NOT NULL REFERENCES condo_expense_periods(id) ON DELETE CASCADE,
  expense_item_id VARCHAR(36)   REFERENCES condo_expense_items(id) ON DELETE SET NULL,
  name            VARCHAR(200)  NOT NULL,
  category        VARCHAR(50)   NOT NULL DEFAULT 'OTHER',
  expense_type    VARCHAR(10)   NOT NULL CHECK (expense_type IN ('FIXED','VARIABLE')),
  amount          NUMERIC(10,2) NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_condo_period_expense_items_period ON condo_period_expense_items(period_id);
