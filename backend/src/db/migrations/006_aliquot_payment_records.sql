-- ============================================================
-- Migración 006 — Detalle de abonos de alícuotas
-- Permite guardar varios pagos/comprobantes para una misma alícuota.
-- ============================================================

CREATE TABLE IF NOT EXISTS aliquot_payment_records (
  id                 VARCHAR(36)   NOT NULL PRIMARY KEY,
  payment_id         VARCHAR(36)   NOT NULL,
  owner_id           VARCHAR(36)   NOT NULL,
  period_id          VARCHAR(36)   NOT NULL,
  amount             NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  amount_for_period  NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_for_mora    NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_date       DATE          NOT NULL,
  proof_url          TEXT,
  proof_public_id    TEXT,
  notes              TEXT,
  source_type        VARCHAR(20)   NOT NULL DEFAULT 'MANUAL'
                       CHECK (source_type IN ('MANUAL','OCR','PROOF')),
  registered_by      VARCHAR(36),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_aliquot_payment_records_payment
    ON aliquot_payment_records(payment_id, payment_date DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_aliquot_payment_records_owner
    ON aliquot_payment_records(owner_id, payment_date DESC);
  CREATE INDEX IF NOT EXISTS idx_aliquot_payment_records_period
    ON aliquot_payment_records(period_id);
  CREATE INDEX IF NOT EXISTS idx_aliquot_payment_records_proof
    ON aliquot_payment_records(proof_public_id);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

INSERT INTO aliquot_payment_records
  (id, payment_id, owner_id, period_id, amount, amount_for_period, amount_for_mora,
   payment_date, proof_url, proof_public_id, notes, source_type, registered_by, created_at)
SELECT
  'backfill-' || SUBSTRING(MD5(ap.id) FROM 1 FOR 27),
  ap.id,
  ap.owner_id,
  ap.period_id,
  ap.paid_amount,
  ap.paid_amount,
  0,
  COALESCE(ap.payment_date, ap.created_at::date),
  ap.proof_url,
  ap.proof_public_id,
  ap.notes,
  'PROOF',
  ap.registered_by,
  ap.created_at
FROM aliquot_payments ap
WHERE ap.paid_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM aliquot_payment_records pr WHERE pr.payment_id = ap.id
  )
ON CONFLICT (id) DO NOTHING;
