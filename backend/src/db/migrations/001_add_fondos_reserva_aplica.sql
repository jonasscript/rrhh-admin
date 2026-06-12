-- Migration: Add fondos_reserva_aplica to employees
-- Run once against the existing database

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS fondos_reserva_aplica BOOLEAN NOT NULL DEFAULT FALSE;
