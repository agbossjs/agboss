-- The offline payment provider's charges, one row per charge; the rowid numbers them. No
-- idempotency key of its own: the row is written in the charge's fenced effect (#500), whose
-- transaction makes it once per step.
CREATE TABLE IF NOT EXISTS payment_charges (
  customer_id TEXT NOT NULL,
  total INTEGER NOT NULL
);
