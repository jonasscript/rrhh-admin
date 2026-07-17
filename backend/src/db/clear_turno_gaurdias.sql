-- ============================================================
-- LIMPIEZA TOTAL DE TURNOS DE GUARDIAS
-- Elimina todas las asignaciones de turnos generadas.
--
-- Conserva:
--   - empleados
--   - usuarios
--   - plantillas de turno (Diurno, Vespertino, Nocturno, Descanso, etc.)
--
-- Nota: el nombre del archivo conserva "gaurdias" porque fue solicitado así.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'shift_assignments'
  ) THEN
    DELETE FROM shift_assignments;
  END IF;
END $$;

COMMIT;
