import type { Class, Provider } from "../components/injection.js";

/**
 * A storage driver (#1321): the value `@DatabaseStorage`, `@ClusterStorage` and `@ObjectStorage` take
 * as `driver` — what `SqliteDriver({ path })`, `S3Driver({ bucket })` and a store package's
 * `PostgresDriver({ url })` return. It carries the driver's options (`settings`, with `env(…)` /
 * `secret(…)` references still in them — read once, at start) and what the container creates for
 * its role (`providers`: the store classes and what their connection needs). Built only by
 * `defineStorageDriver`, so a literal is not a driver.
 */

/** What a storage component is for. */
export enum StorageRole {
  /** The durable rows: records, ledger, pauses, history, fenced effects, … (`@DatabaseStorage`). */
  Database = "database",
  /** The rows that coordinate instances: leases, the child queue, rate limits (`@ClusterStorage`). */
  Cluster = "cluster",
  /** The files (`@ObjectStorage`). */
  Objects = "objects",
}

declare const driverBrand: unique symbol;

/** The options of a driver, as its connection reads them once resolved; `kind` names the driver. */
export interface DriverSettings {
  readonly kind: string;
  readonly [option: string]: unknown;
}

/** One storage driver for the role `TRole`. */
export interface StorageDriver<TRole extends StorageRole = StorageRole> {
  readonly [driverBrand]: true;
  readonly role: TRole;
  /**
   * The backend its stores declare (`static store = { backend }`): `"sqlite"`, `"postgres"`,
   * `"in-memory"` — what assembly checks the lease and fencing stores share.
   */
  readonly backend: string;
  /** A line for `agboss describe`: where it points, never a secret. */
  readonly describes: string;
  /** Its options; resolved with the process's variables when the application starts. */
  readonly settings: DriverSettings;
  /** What the container creates for its role: the store classes, then the classes and values they need. */
  readonly providers: readonly Provider[];
  /**
   * Of its `providers`, the stores of the rows that coordinate instances — the lease store, the
   * child queue, the rate limits —: a `@ClusterStorage` takes their place when the application has one.
   */
  readonly coordinationStores?: readonly Class[] | undefined;
  /** A database driver's durable lease store: where a cluster's lease keeps its ids and its marks. */
  readonly leaseStore?: Class | undefined;
}

/** The driver of `@DatabaseStorage`. */
export type DatabaseDriver = StorageDriver<StorageRole.Database>;
/** The driver of `@ClusterStorage`. */
export type ClusterDriver = StorageDriver<StorageRole.Cluster>;
/** The driver of `@ObjectStorage`. */
export type ObjectDriver = StorageDriver<StorageRole.Objects>;

/** What a driver package gives `defineStorageDriver`. */
export type StorageDriverSpec<TRole extends StorageRole> = Omit<
  StorageDriver<TRole>,
  typeof driverBrand
>;

const DRIVERS = new WeakSet<object>();

/** Makes a driver: what a store package's `PostgresDriver(…)` returns. */
export function defineStorageDriver<TRole extends StorageRole>(
  spec: StorageDriverSpec<TRole>,
): StorageDriver<TRole> {
  const driver = Object.freeze({ ...spec }) as StorageDriver<TRole>;
  DRIVERS.add(driver);
  return driver;
}

/** Whether `value` was made by `defineStorageDriver`, and for which role. */
export const storageDriverOf = (value: unknown): StorageDriver | undefined =>
  typeof value === "object" && value !== null && DRIVERS.has(value)
    ? (value as StorageDriver)
    : undefined;
