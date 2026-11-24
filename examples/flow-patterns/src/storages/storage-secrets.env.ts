import { defineEnv, secret } from "@agboss/core";

/**
 * The keys of the two applications' database storage (#1321), read through `defineEnv` when the
 * application starts — never a literal here. Each is a variable of its own: rotating one would
 * change every value made with the other (`[storage.secret-shared]`). A test sets none: `testWith`
 * has a fixed key of its own for each.
 */
export const storageSecrets = defineEnv({
  /** The HMAC key of the business-key fingerprints of `Idempotency` (the credit desk's charge). */
  idempotencySecret: secret("AGBOSS_IDEMPOTENCY_SECRET"),
  /** The application's PII key: one token per value on every instance (#120). */
  piiSecret: secret("PII_PSEUDONYM_KEY"),
});
