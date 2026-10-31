import type { App } from "../../app/types.js";
import { InjectionToken, type Class } from "../../components/injection.js";

/**
 * The store set a fault suite runs on (#484 AC4): what a store author's module exports as
 * `faultStores` — the store classes as an application lists them, the environment they read, and
 * how the fixture's charge writes its business row in the fenced effect's transaction and reads
 * the committed rows back. Every pod imports the module and lists the stores, the fencing ones
 * and the child queue with their hold points (`withHoldPoints`).
 */

/** How the fixture writes a business row in a fenced effect's transaction, and reads them back. */
export interface FaultBusinessRows<TTransaction = unknown> {
  /**
   * Writes `row` in `transaction` — synchronously (`undefined`) for a store whose work must be (the
   * SQLite one), a promise for one whose work may wait.
   */
  insert(transaction: TTransaction, row: string): void | Promise<void>;
  /** The rows committed so far, read through the pod's application (its connection). */
  committed(app: App): Promise<readonly string[]>;
}

/** The environment the stores read: the contract, and its values with the database's address. */
export interface FaultEnvironment {
  /** The contract class (`@Application({ environment })`): every field a store reads. */
  readonly contract: Class;
  /**
   * The values, as an environment file's (`env(…)`, `secret(…)`): the database's address is the
   * process variable `AGBOSS_FAULT_DATABASE_URL` — `secret("AGBOSS_FAULT_DATABASE_URL")`.
   */
  readonly values: Readonly<Record<string, unknown>>;
}

/** What a store set's module exports as `faultStores`. */
export interface FaultStores<TTransaction = unknown> {
  /**
   * Every store class, as `@Application({ providers })` lists them: the lease, fenced-effect,
   * outbound-call, lease-log, record, tree, history, child-queue and paused stores and the
   * checkpoint saver, all on the one shared database (an in-memory default is not shared between
   * processes, so each must be listed).
   */
  readonly providers: readonly Class[];
  readonly environment: FaultEnvironment;
  readonly businessRows: FaultBusinessRows<TTransaction>;
}

/** The business rows of the pod's store set, as the fixture's charge injects them. */
export const FAULT_BUSINESS_ROWS = new InjectionToken<FaultBusinessRows>("fault-business-rows");

/** The name of the export a store set's module gives. */
export const FAULT_STORES_EXPORT = "faultStores";

/** Typed `faultStores` (a store set's module: `export const faultStores = defineFaultStores({ … })`). */
export const defineFaultStores = <TTransaction>(
  stores: FaultStores<TTransaction>,
): FaultStores<TTransaction> => stores;
