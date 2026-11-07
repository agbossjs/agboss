import type { Secret } from "../../../../../src/index.js";

/** The SQLite fixtures' environment contract: the file their SQLite implementations share. */
export class SqliteTestEnvironment {
  sqlitePath!: string;
  /** The idempotency key of the fixtures that write under business keys (#825): `testWith` gives it. */
  idempotencyKey?: Secret;
}
