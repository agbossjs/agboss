-- The offline payment provider's charges: one row per idempotency key, its primary key, so a second
-- request with the same key cannot add a charge. The rowid numbers the charges.
CREATE TABLE IF NOT EXISTS payment_charges (
  idempotency_key TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  total INTEGER NOT NULL
);
