-- Migration 002: Obligaciones Laborales del Empleador
-- Crea la tabla employee_labor_obligations, migra datos de employees
-- y elimina las columnas movidas.

-- 1. Crear tabla
CREATE TABLE IF NOT EXISTS employee_labor_obligations (
  id                    VARCHAR(36)   NOT NULL PRIMARY KEY,
  employee_id           VARCHAR(36)   NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  fondos_reserva_aplica BOOLEAN       NOT NULL DEFAULT FALSE,
  iess_quirografario    NUMERIC(10,2) NOT NULL DEFAULT 0,
  iess_hipotecario      NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes                 TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 2. Trigger updated_at (reutiliza la función ya existente set_updated_at)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_labor_obligations_updated_at'
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_labor_obligations_updated_at
        BEFORE UPDATE ON employee_labor_obligations
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    ';
  END IF;
END $$;

-- 3. Migrar datos existentes de employees (usando employee id como pk del registro)
INSERT INTO employee_labor_obligations
  (id, employee_id, fondos_reserva_aplica, iess_quirografario, iess_hipotecario)
SELECT
  id,
  id,
  COALESCE(fondos_reserva_aplica, FALSE),
  COALESCE(iess_quirografario, 0),
  COALESCE(iess_hipotecario, 0)
FROM employees
ON CONFLICT (employee_id) DO NOTHING;

-- 4. Eliminar columnas ya migradas de employees
ALTER TABLE employees
  DROP COLUMN IF EXISTS fondos_reserva_aplica,
  DROP COLUMN IF EXISTS iess_quirografario,
  DROP COLUMN IF EXISTS iess_hipotecario;
