-- ============================================================
-- ELIMINAR UN PERIODO DE CONDOMINIO POR ID
-- Borra el periodo, sus alicuotas, cargos extras, registros de pago,
-- abonos de mora relacionados, snapshot de gastos y movimientos de fondos
-- vinculados al periodo.
--
-- USO:
-- 1. Reemplaza solo el valor dentro del INSERT por el id real del periodo.
-- 2. Ejecuta este archivo contra la base PostgreSQL.
--
-- ADVERTENCIA:
-- - Esta accion es irreversible.
-- - Los archivos cargados en Cloudinary no se eliminan desde SQL.
-- - Si algun pago de este periodo fue aplicado a mora de periodos antiguos,
--   el script revierte ese abono en la deuda antigua y en mora_amount.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS _delete_condo_period_target;
DROP TABLE IF EXISTS _delete_condo_period_payments;
DROP TABLE IF EXISTS _delete_condo_period_summary;
DROP TABLE IF EXISTS _delete_condo_period_mora_to_reverse;

CREATE TEMP TABLE _delete_condo_period_target (
  id VARCHAR(36) PRIMARY KEY
);

INSERT INTO _delete_condo_period_target (id)
VALUES ('70979555-8374-4e1b-9104-8b5f55f6ec62');

DO $$
DECLARE
  v_period_id VARCHAR(36);
BEGIN
  SELECT id INTO v_period_id FROM _delete_condo_period_target;

  IF v_period_id IS NULL OR v_period_id = '' OR v_period_id LIKE 'REEMPLAZAR_%' OR v_period_id LIKE 'PERIOD_ID_%' THEN
    RAISE EXCEPTION 'Coloca el id real del periodo en el INSERT de _delete_condo_period_target.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM condo_expense_periods WHERE id = v_period_id) THEN
    RAISE EXCEPTION 'No existe un periodo de condominio con id %', v_period_id;
  END IF;
END $$;

CREATE TEMP TABLE _delete_condo_period_payments AS
SELECT
  ap.id,
  ap.owner_id,
  ap.status,
  ap.paid_amount,
  (
    ap.aliquot_amount +
    COALESCE((
      SELECT SUM(e.amount)
      FROM aliquot_payment_extras e
      WHERE e.payment_id = ap.id
    ), 0)
  )::numeric AS total_due,
  GREATEST(0, (
    ap.aliquot_amount +
    COALESCE((
      SELECT SUM(e.amount)
      FROM aliquot_payment_extras e
      WHERE e.payment_id = ap.id
    ), 0)
  ) - ap.paid_amount)::numeric AS pending_amount
FROM aliquot_payments ap
JOIN _delete_condo_period_target target ON target.id = ap.period_id;

CREATE TEMP TABLE _delete_condo_period_summary (
  period_id VARCHAR(36),
  period_label TEXT,
  period_status TEXT,
  aliquot_payments INTEGER DEFAULT 0,
  aliquot_payment_extras INTEGER DEFAULT 0,
  aliquot_payment_records INTEGER DEFAULT 0,
  mora_payment_records INTEGER DEFAULT 0,
  condo_period_expense_items INTEGER DEFAULT 0,
  condo_fund_entries INTEGER DEFAULT 0
);

INSERT INTO _delete_condo_period_summary (
  period_id,
  period_label,
  period_status,
  aliquot_payments,
  aliquot_payment_extras,
  condo_period_expense_items
)
SELECT
  p.id,
  LPAD(p.month::text, 2, '0') || '/' || p.year::text,
  p.status::text,
  (SELECT COUNT(*) FROM _delete_condo_period_payments)::integer,
  (
    SELECT COUNT(*)
    FROM aliquot_payment_extras e
    JOIN _delete_condo_period_payments ap ON ap.id = e.payment_id
  )::integer,
  (
    SELECT COUNT(*)
    FROM condo_period_expense_items i
    JOIN _delete_condo_period_target target ON target.id = i.period_id
  )::integer
FROM condo_expense_periods p
JOIN _delete_condo_period_target target ON target.id = p.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'aliquot_payment_records'
  ) THEN
    UPDATE _delete_condo_period_summary
    SET aliquot_payment_records = (
      SELECT COUNT(*)
      FROM aliquot_payment_records r
      JOIN _delete_condo_period_target target ON target.id = r.period_id
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mora_payment_records'
  ) THEN
    UPDATE _delete_condo_period_summary
    SET mora_payment_records = (
      SELECT COUNT(*)
      FROM mora_payment_records r
      WHERE r.aliquot_payment_id IN (SELECT id FROM _delete_condo_period_payments)
         OR r.debt_payment_id IN (SELECT id FROM _delete_condo_period_payments)
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'condo_fund_entries'
      AND column_name = 'period_id'
  ) THEN
    UPDATE _delete_condo_period_summary
    SET condo_fund_entries = (
      SELECT COUNT(*)
      FROM condo_fund_entries f
      JOIN _delete_condo_period_target target ON target.id = f.period_id
    );
  END IF;
END $$;

-- 1) Quitar de mora_amount el saldo pendiente que este periodo cerrado
--    todavia aporta como mora.
WITH overdue_to_remove AS (
  SELECT owner_id, SUM(pending_amount) AS amount
  FROM _delete_condo_period_payments
  WHERE status = 'OVERDUE'
  GROUP BY owner_id
)
UPDATE condo_owners o
SET mora_amount = GREATEST(0, o.mora_amount - overdue_to_remove.amount)
FROM overdue_to_remove
WHERE o.id = overdue_to_remove.owner_id;

-- 2) Si pagos del periodo que se elimina fueron usados para cubrir mora
--    de otros periodos, revertir esa aplicacion.
CREATE TEMP TABLE _delete_condo_period_mora_to_reverse (
  owner_id VARCHAR(36) NOT NULL,
  debt_payment_id VARCHAR(36),
  amount NUMERIC(10,2) NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mora_payment_records'
  ) THEN
    INSERT INTO _delete_condo_period_mora_to_reverse (owner_id, debt_payment_id, amount)
    SELECT r.owner_id, r.debt_payment_id, r.amount
    FROM mora_payment_records r
    WHERE r.aliquot_payment_id IN (SELECT id FROM _delete_condo_period_payments)
      AND (
        r.debt_payment_id IS NULL
        OR r.debt_payment_id NOT IN (SELECT id FROM _delete_condo_period_payments)
      );
  END IF;
END $$;

WITH reversed_by_debt AS (
  SELECT debt_payment_id, SUM(amount) AS amount
  FROM _delete_condo_period_mora_to_reverse
  WHERE debt_payment_id IS NOT NULL
  GROUP BY debt_payment_id
),
debt_totals AS (
  SELECT
    ap.id,
    GREATEST(0, ap.paid_amount - reversed_by_debt.amount)::numeric AS new_paid,
    (
      ap.aliquot_amount +
      COALESCE((
        SELECT SUM(e.amount)
        FROM aliquot_payment_extras e
        WHERE e.payment_id = ap.id
      ), 0)
    )::numeric AS total_due
  FROM aliquot_payments ap
  JOIN reversed_by_debt ON reversed_by_debt.debt_payment_id = ap.id
)
UPDATE aliquot_payments ap
SET
  paid_amount = debt_totals.new_paid,
  status = CASE
    WHEN debt_totals.new_paid >= debt_totals.total_due - 0.01 THEN 'PAID'::payment_status
    ELSE 'OVERDUE'::payment_status
  END
FROM debt_totals
WHERE ap.id = debt_totals.id;

WITH reversed_by_owner AS (
  SELECT owner_id, SUM(amount) AS amount
  FROM _delete_condo_period_mora_to_reverse
  GROUP BY owner_id
)
UPDATE condo_owners o
SET mora_amount = o.mora_amount + reversed_by_owner.amount
FROM reversed_by_owner
WHERE o.id = reversed_by_owner.owner_id;

-- 3) Eliminar registros relacionados en orden seguro.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mora_payment_records'
  ) THEN
    DELETE FROM mora_payment_records r
    WHERE r.aliquot_payment_id IN (SELECT id FROM _delete_condo_period_payments)
       OR r.debt_payment_id IN (SELECT id FROM _delete_condo_period_payments);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'aliquot_payment_records'
  ) THEN
    DELETE FROM aliquot_payment_records r
    WHERE r.period_id IN (SELECT id FROM _delete_condo_period_target)
       OR r.payment_id IN (SELECT id FROM _delete_condo_period_payments);
  END IF;
END $$;

DELETE FROM aliquot_payment_extras e
USING _delete_condo_period_payments ap
WHERE e.payment_id = ap.id;

DELETE FROM condo_period_expense_items i
USING _delete_condo_period_target target
WHERE i.period_id = target.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'condo_fund_entries'
      AND column_name = 'period_id'
  ) THEN
    DELETE FROM condo_fund_entries f
    USING _delete_condo_period_target target
    WHERE f.period_id = target.id;
  END IF;
END $$;

DELETE FROM aliquot_payments ap
USING _delete_condo_period_target target
WHERE ap.period_id = target.id;

DELETE FROM condo_expense_periods p
USING _delete_condo_period_target target
WHERE p.id = target.id;

COMMIT;

SELECT
  period_id,
  period_label,
  period_status,
  aliquot_payments,
  aliquot_payment_extras,
  aliquot_payment_records,
  mora_payment_records,
  condo_period_expense_items,
  condo_fund_entries,
  'Periodo eliminado. Verifica Cloudinary si necesitas borrar archivos fisicos.' AS note
FROM _delete_condo_period_summary;
