-- ============================================================
-- Migración 005 — Gastos administrativos del condominio
-- Libro de gastos reales con recibo obligatorio.
-- ============================================================

CREATE TABLE IF NOT EXISTS condo_admin_expenses (
  id               VARCHAR(36)   NOT NULL PRIMARY KEY,
  expense_date     DATE          NOT NULL,
  expense_type     VARCHAR(20)   NOT NULL DEFAULT 'ADMINISTRATIVE'
                     CHECK (expense_type IN ('ADMINISTRATIVE','BUILDING_SERVICE','MAINTENANCE','OTHER')),
  category         VARCHAR(50)   NOT NULL DEFAULT 'ADMINISTRATION'
                     CHECK (category IN ('MAINTENANCE','SECURITY','CLEANING','UTILITIES','ADMINISTRATION','REPAIR','SUPPLIES','OTHER')),
  vendor           VARCHAR(180)  NOT NULL,
  description      TEXT          NOT NULL,
  amount           NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  payment_method   VARCHAR(30)   NOT NULL DEFAULT 'TRANSFER'
                     CHECK (payment_method IN ('CASH','TRANSFER','CARD','CHECK','OTHER')),
  receipt_url      TEXT          NOT NULL,
  receipt_public_id TEXT         NOT NULL,
  notes            TEXT,
  registered_by    VARCHAR(36)   REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER trg_condo_admin_expenses_updated_at
    BEFORE UPDATE ON condo_admin_expenses FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_condo_admin_expenses_date
    ON condo_admin_expenses(expense_date DESC);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_condo_admin_expenses_type
    ON condo_admin_expenses(expense_type);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_condo_admin_expenses_category
    ON condo_admin_expenses(category);
EXCEPTION WHEN OTHERS THEN NULL; END $$;
