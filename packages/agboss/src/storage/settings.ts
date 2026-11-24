import { InjectionToken } from "../components/injection.js";
import { sec, type Milliseconds } from "../units/index.js";

/**
 * The settings of an application's storage components (#1321), as a connection reads them: the
 * driver's options with every `env(…)` / `secret(…)` reference replaced by its value, resolved once,
 * when the application starts. A connection class (`SqliteConnection`, a store package's own) lists
 * the token of its role in `deps` and checks `kind` — the driver that made them — before it reads a
 * field; `undefined` is an application that names no storage component (the environment's fields
 * are then read, until they are removed).
 */
export interface ResolvedSettings {
  /** The driver that made them: `"sqlite"`, `"postgres"`, `"s3"`, … */
  readonly kind: string;
  readonly [option: string]: unknown;
}

/** The resolved settings of `@DatabaseStorage`'s driver; `undefined` when the application has none. */
export const DATABASE_SETTINGS = new InjectionToken<ResolvedSettings | undefined>(
  "DATABASE_SETTINGS",
);

/** The resolved settings of `@ClusterStorage`'s driver; `undefined` when the application has none. */
export const CLUSTER_SETTINGS = new InjectionToken<ResolvedSettings | undefined>(
  "CLUSTER_SETTINGS",
);

/** The resolved settings of `@ObjectStorage`'s driver; `undefined` when the application has none. */
export const OBJECT_SETTINGS = new InjectionToken<ResolvedSettings | undefined>("OBJECT_SETTINGS");

/** The three, each registered as `undefined` unless an application's storage resolves it. */
export const STORAGE_SETTINGS_TOKENS: readonly InjectionToken<ResolvedSettings | undefined>[] = [
  DATABASE_SETTINGS,
  CLUSTER_SETTINGS,
  OBJECT_SETTINGS,
];

/** What an application instance's storage components resolved to, by role. */
export interface ResolvedStorage {
  readonly database?: ResolvedSettings | undefined;
  readonly cluster?: ResolvedSettings | undefined;
  readonly objects?: ResolvedSettings | undefined;
}

/** The core values of an application instance for the three tokens: what its storage resolved to. */
export const settingsEntriesOf = (
  storage: ResolvedStorage | undefined,
): readonly (readonly [
  InjectionToken<ResolvedSettings | undefined>,
  ResolvedSettings | undefined,
])[] => [
  [DATABASE_SETTINGS, storage?.database],
  [CLUSTER_SETTINGS, storage?.cluster],
  [OBJECT_SETTINGS, storage?.objects],
];

/**
 * How long a database driver's watch of the cluster lives without an answer: the default of
 * `watchLiveness` (#1321f; it was `DEFAULT_WATCH_LIVENESS_SECONDS`, a raw number of seconds).
 */
export const DEFAULT_WATCH_LIVENESS: Milliseconds = sec(10);

/**
 * The time options of a networked driver (`PostgresDriver`, `MongoDriver`, `RedisDriver`), every one
 * a `Milliseconds` (#1321f; `env.duration("…")` gives one): replace the raw `watchLivenessSeconds`
 * and `commandTimeout` numbers. Optional: a driver without them uses its defaults.
 */
export interface DriverTimeouts {
  /** How long a watch (`watchQueued`, a lease watch) may stay silent before it is re-opened; `DEFAULT_WATCH_LIVENESS`. */
  readonly watchLiveness?: Milliseconds;
  /** How long one command may run before it is cancelled. */
  readonly commandTimeout?: Milliseconds;
  /** How long a transaction may sit idle before the server ends it (PostgreSQL). */
  readonly idleInTransactionTimeout?: Milliseconds;
}
