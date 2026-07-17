-- Migración 007 — Horarios oficiales de turnos de guardias
-- Mañana: 07:00-15:00, Tarde: 15:00-21:00, Noche: 21:00-07:00.

UPDATE shift_templates
   SET start_time = '07:00',
       end_time = '15:00',
       color = '#22C55E',
       is_active = TRUE
 WHERE id = 'system-shift-diurno'
    OR lower(name) IN ('mañana', 'manana', 'diurno');

INSERT INTO shift_templates (id, name, start_time, end_time, color)
SELECT 'system-shift-diurno', 'Mañana', '07:00', '15:00', '#22C55E'
WHERE NOT EXISTS (
  SELECT 1 FROM shift_templates
   WHERE id = 'system-shift-diurno'
      OR lower(name) IN ('mañana', 'manana', 'diurno')
);

UPDATE shift_templates
   SET start_time = '15:00',
       end_time = '21:00',
       color = '#F59E0B',
       is_active = TRUE
 WHERE id = 'system-shift-vespertino'
    OR lower(name) IN ('tarde', 'vespertino');

INSERT INTO shift_templates (id, name, start_time, end_time, color)
SELECT 'system-shift-vespertino', 'Tarde', '15:00', '21:00', '#F59E0B'
WHERE NOT EXISTS (
  SELECT 1 FROM shift_templates
   WHERE id = 'system-shift-vespertino'
      OR lower(name) IN ('tarde', 'vespertino')
);

UPDATE shift_templates
   SET start_time = '21:00',
       end_time = '07:00',
       color = '#6366F1',
       is_active = TRUE
 WHERE id = 'system-shift-nocturno'
    OR lower(name) IN ('noche', 'nocturno');

INSERT INTO shift_templates (id, name, start_time, end_time, color)
SELECT 'system-shift-nocturno', 'Noche', '21:00', '07:00', '#6366F1'
WHERE NOT EXISTS (
  SELECT 1 FROM shift_templates
   WHERE id = 'system-shift-nocturno'
      OR lower(name) IN ('noche', 'nocturno')
);
