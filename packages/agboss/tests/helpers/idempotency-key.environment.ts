import type { Secret } from "../../src/index.js";

/**
 * The environment contract of a test application that writes under business keys and needs no other
 * setting (#825): its idempotency key alone — `@Application({ environment: IdempotencyKeyEnvironment,
 * idempotencyKeyField: "idempotencyKey" })`, with `environments/test.environment.ts` in its folder.
 * The test environments leave the key out: `testWith` gives the test's keys to a key field with no
 * value, as it gives the PII key.
 */
export class IdempotencyKeyEnvironment {
  idempotencyKey?: Secret;
}
