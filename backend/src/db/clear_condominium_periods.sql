-- ============================================================
-- LIMPIEZA TOTAL DE PERÍODOS DE CONDOMINIO
-- Elimina períodos DRAFT, APPROVED y CLOSED, con toda su data
-- dependiente. Conserva propietarios, configuración, catálogos
-- y movimientos de fondos que no pertenecen a un período.
--
-- ADVERTENCIA: también reinicia la mora de propietarios a $0,
-- pues al no existir períodos ya no debe conservarse deuda
-- acumulada de ellos.
-- ============================================================

BEGIN;

-- Cargos extras de pagos (también se eliminan por CASCADE, pero
-- se borran explícitamente para que el script funcione con esquemas antiguos).
DELETE FROM aliquot_payment_extras e
USING aliquot_payments ap
WHERE e.payment_id = ap.id;

-- Movimientos de fondos generados o vinculados a cualquier período.
-- Algunas instalaciones antiguas no tienen aún la columna period_id; se
-- verifica antes de referenciarla para que la limpieza no falle.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'condo_fund_entries'
      AND column_name = 'period_id'
  ) THEN
    EXECUTE 'DELETE FROM condo_fund_entries WHERE period_id IS NOT NULL';
  END IF;
END $$;

-- Snapshot de gastos usados al crear cada período.
DELETE FROM condo_period_expense_items;

-- Comprobantes, pagos y estado de cada alícuota.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mora_payment_records'
  ) THEN
    DELETE FROM mora_payment_records
    WHERE aliquot_payment_id IS NOT NULL;
  END IF;
END $$;

DELETE FROM aliquot_payments;

-- Incluye períodos cerrados: SQL no aplica la restricción de la API.
DELETE FROM condo_expense_periods;

-- Eliminar la mora generada por los períodos que acaban de borrarse.
UPDATE condo_owners
SET mora_amount = 0;

COMMIT;

-- Nota: los archivos ya cargados en Cloudinary no se pueden borrar desde SQL.
-- Deben eliminarse mediante Cloudinary o mediante un proceso backend antes de
-- ejecutar este script si también se requiere liberar ese almacenamiento.
