import type { Secret } from "../../../../../src/index.js";

/** The rotation fixture's contract (#825): its SQLite file and two idempotency keys. */
export class RotationEnvironment {
  sqlitePath!: string;
  /** The key before the rotation. */
  idempotencyKeyV1!: Secret;
  /** The key after it (`test` leaves it out: its applications run on V1). */
  idempotencyKeyV2?: Secret;
  /** A provider's key: never an idempotency key (`test` leaves it out). */
  openRouterApiKey?: Secret;
}
