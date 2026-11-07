import type { IdempotencyKeyEnvironment } from "../../../helpers/idempotency-key.environment.js";

/**
 * The test applications of this folder that write under business keys: their idempotency key left
 * out — `testWith` gives them the test's keys (#825).
 */
export const environment: IdempotencyKeyEnvironment = {};
