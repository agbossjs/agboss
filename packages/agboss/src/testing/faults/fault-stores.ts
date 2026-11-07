import type { App } from "../../app/types.js";
import { InjectionToken, type Class } from "../../components/injection.js";
import { optsOutOfLeaseCheck } from "../../infrastructure/execution-lease.repository.js";

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

/**
 * What a store set's stores decide a lease's time by (#799): the run's history is read on that time
 * — the linearizability checker maps it from the machine's clock by the rate it runs at.
 */
export enum FaultStoreTime {
  /**
   * The database's own clock, at the real rate, whatever the pods' `timeScale`: PostgreSQL's
   * `clock_timestamp()`, MongoDB's `$$NOW`, Redis's `TIME`.
   */
  Database = "database",
  /**
   * The host's clock the pods run on, at the suite's `timeScale`: the in-memory and SQLite stores,
   * which read `now()` in the process.
   */
  Host = "host",
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
  /**
   * The time the fencing stores (leases, fenced effects, outbound calls) decide by (#799): the
   * history of a run is checked on it. A property of the stores, not of a run: required.
   */
  readonly storeTime: FaultStoreTime;
}

/** The business rows of the pod's store set, as the fixture's charge injects them. */
export const FAULT_BUSINESS_ROWS = new InjectionToken<FaultBusinessRows>("fault-business-rows");

/** The name of the export a store set's module gives. */
export const FAULT_STORES_EXPORT = "faultStores";

/** Typed `faultStores` (a store set's module: `export const faultStores = defineFaultStores({ … })`). */
export const defineFaultStores = <TTransaction>(
  stores: FaultStores<TTransaction>,
): FaultStores<TTransaction> => stores;

/** A store set whose `storeTime` is missing or unknown (#799): its pods do not start. */
export class FaultStoreTimeError extends Error {
  override name = "FaultStoreTimeError";

  constructor(given: unknown) {
    super(
      `[fault-suite.store-time] the store set's storeTime is ${given === undefined ? "missing" : JSON.stringify(given)}: declare what its fencing stores decide a lease's time by — FaultStoreTime.Database (the database's own clock, at the real rate) or FaultStoreTime.Host (the pods' clock, at the suite's timeScale)`,
    );
  }
}

/** The set's declared store time; `FaultStoreTimeError` for none or an unknown one. */
export function storeTimeOf(stores: FaultStores): FaultStoreTime {
  const given: unknown = Reflect.get(stores, "storeTime");
  if (given === FaultStoreTime.Database || given === FaultStoreTime.Host) return given;
  throw new FaultStoreTimeError(given);
}

/**
 * How much faster than real time the history's store time ran (#799): 1 on a database's own
 * clock, the pods' `timeScale` on the host's.
 */
export const storeTimeScaleOf = (storeTime: FaultStoreTime, timeScale: number): number =>
  storeTime === FaultStoreTime.Database ? 1 : timeScale;

/**
 * The store classes of `stores` that opt out of the atomic lease check (#584,
 * `LeaseCheck.WithoutDoubleChargeProtection`): a set with any protects no payment, whatever its
 * scenarios show.
 */
export const optedOutStoresOf = (stores: FaultStores): readonly string[] =>
  stores.providers.filter((store) => optsOutOfLeaseCheck(store)).map((store) => store.name);
