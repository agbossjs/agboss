import { provide, type Class, type Provider } from "../components/injection.js";
import { resolveReferences } from "../environments/define-env.js";
import { EXECUTION_ID_STORE, type ExecutionIdStore } from "../infrastructure/execution-id-store.js";
import { Ttl, type Milliseconds } from "../units/index.js";
import type { ResolvedSettings, ResolvedStorage } from "./settings.js";
import {
  clusterStorageOf,
  databaseStorageOf,
  DECORATOR_OF,
  objectStorageOf,
  type ClusterStorageMeta,
  type DatabaseStorageMeta,
  type ObjectStorageMeta,
} from "./storage-decorators.js";
import { storageDriverOf, StorageRole, type StorageDriver } from "./storage-driver.js";

/**
 * `@Application({ storage })` (#1321, #1324): `storage: AppDatabaseStorage` or `storage: { database,
 * cluster?, objects? }` — the components that say where the application's rows go. The assembly
 * turns them into what the container creates (the drivers' stores, in the place the application's
 * `providers` were): the durable stores on the database, the rows that coordinate instances (leases,
 * the child queue, rate limits) on the cluster when there is one, the files on the objects.
 */

/** The three storage components of an application, each a class decorated for its role. */
export interface ApplicationStorageOptions {
  readonly database: Class;
  /** Leases, the child queue and rate limits go here instead of the database. */
  readonly cluster?: Class;
  /** Files go here. */
  readonly objects?: Class;
}

/** What `@Application({ storage })` takes: the database alone, or all the components. */
export type ApplicationStorage = Class | ApplicationStorageOptions;

/** The storage components an application declared, with what each recorded. */
export interface AssembledStorage {
  readonly database?: { readonly cls: Class; readonly meta: DatabaseStorageMeta };
  readonly cluster?: { readonly cls: Class; readonly meta: ClusterStorageMeta };
  readonly objects?: { readonly cls: Class; readonly meta: ObjectStorageMeta };
}

export const isFunction = (value: unknown): value is Class => typeof value === "function";

/** The components of a `storage` option as given; a shape that is none gives none (the rules say why). */
export function declaredOf(
  storage: unknown,
): Readonly<Record<"database" | "cluster" | "objects", unknown>> {
  if (isFunction(storage)) return { database: storage, cluster: undefined, objects: undefined };
  const given = typeof storage === "object" && storage !== null ? storage : {};
  const { database, cluster, objects } = given as Record<string, unknown>;
  return { database, cluster, objects };
}

/** The storage components of `storage` that are decorated for their role; the rest are the rules' to name. */
export function assembledStorageOf(storage: unknown): AssembledStorage | undefined {
  if (storage === undefined) return undefined;
  const declared = declaredOf(storage);
  const entry = <TMeta>(cls: unknown, metaOf: (cls: Class) => TMeta | undefined) => {
    const meta = isFunction(cls) ? metaOf(cls) : undefined;
    return isFunction(cls) && meta !== undefined ? { cls, meta } : undefined;
  };
  const database = entry(declared.database, databaseStorageOf);
  const cluster = entry(declared.cluster, clusterStorageOf);
  const objects = entry(declared.objects, objectStorageOf);
  return {
    ...(database === undefined ? {} : { database }),
    ...(cluster === undefined ? {} : { cluster }),
    ...(objects === undefined ? {} : { objects }),
  };
}

/** The driver a component recorded, when it was made by `defineStorageDriver` for `role`. */
export const driverOf = (
  meta: { readonly driver: unknown } | undefined,
  role: StorageRole,
): StorageDriver | undefined => {
  const driver = storageDriverOf(meta?.driver);
  return driver?.role === role ? driver : undefined;
};

/** The class a provider makes: itself, or the class given for a token. */
export const classOf = (provider: Provider): Class | undefined => {
  if (isFunction(provider)) return provider;
  return "useClass" in provider ? provider.useClass : undefined;
};

/** The database's stores: all of them, but the ones a cluster takes over. */
const databaseProvidersOf = (
  database: StorageDriver | undefined,
  hasCluster: boolean,
): readonly Provider[] =>
  (database?.providers ?? []).filter(
    (provider) => !hasCluster || !(database?.coordinationStores ?? []).includes(provider as Class),
  );

/** A cluster's lease keeps its execution ids and its cancel mark in the database's lease row. */
const executionIdStoreOf = (database: StorageDriver | undefined): readonly Provider[] =>
  database?.leaseStore === undefined
    ? []
    : [provide(EXECUTION_ID_STORE, database.leaseStore as Class<ExecutionIdStore>)];

/** What the container creates for the storage components, and the classes among them. */
export function storageProvidersOf(storage: AssembledStorage): {
  readonly providers: readonly Provider[];
  readonly owned: ReadonlySet<Class>;
} {
  const database = driverOf(storage.database?.meta, StorageRole.Database);
  const cluster = driverOf(storage.cluster?.meta, StorageRole.Cluster);
  const objects = driverOf(storage.objects?.meta, StorageRole.Objects);
  const providers: Provider[] = [
    ...databaseProvidersOf(database, cluster !== undefined),
    ...(cluster?.providers ?? []),
    ...(objects?.providers ?? []),
    ...(cluster === undefined ? [] : executionIdStoreOf(database)),
  ];
  return { providers, owned: new Set(providers.flatMap((provider) => classOf(provider) ?? [])) };
}

/** The drivers' settings with every reference read from `processEnv`: once per application instance. */
export function resolvedStorageOf(
  storage: AssembledStorage | undefined,
  processEnv: NodeJS.ProcessEnv,
): ResolvedStorage {
  if (storage === undefined) return {};
  const resolve = (
    meta: { readonly driver: unknown } | undefined,
    role: StorageRole,
  ): ResolvedSettings | undefined => {
    const settings = driverOf(meta, role)?.settings;
    return settings === undefined
      ? undefined
      : (resolveReferences(
          settings,
          processEnv,
          `${DECORATOR_OF[role]} driver`,
        ) as ResolvedSettings);
  };
  return {
    database: resolve(storage.database?.meta, StorageRole.Database),
    cluster: resolve(storage.cluster?.meta, StorageRole.Cluster),
    objects: resolve(storage.objects?.meta, StorageRole.Objects),
  };
}

/** One storage component as `agboss describe` lists it. */
export interface DescribedStorage {
  readonly role: StorageRole;
  readonly name: string;
  readonly backend: string;
  readonly describes: string;
}

/** The application's storage components, by role. */
export function storageLinesOf(storage: AssembledStorage | undefined): readonly DescribedStorage[] {
  if (storage === undefined) return [];
  return [
    [StorageRole.Database, storage.database],
    [StorageRole.Cluster, storage.cluster],
    [StorageRole.Objects, storage.objects],
  ].flatMap(([role, entry]) => {
    const found = entry as AssembledStorage["database"];
    const driver = driverOf(found?.meta, role as StorageRole);
    return found === undefined || driver === undefined
      ? []
      : [
          {
            role: role as StorageRole,
            name: found.meta.name,
            backend: driver.backend,
            describes: driver.describes,
          },
        ];
  });
}

/** How long audit-log rows and ledger entries are kept, as the sweep reads it: `undefined` = never removed. */
export function storageRetentionsOf(storage: AssembledStorage | undefined):
  | {
      readonly auditLogRetention: Milliseconds | undefined;
      readonly ledgerEntryRetention: Milliseconds | undefined;
    }
  | undefined {
  const meta = storage?.database?.meta;
  if (meta === undefined) return undefined;
  const { auditLogTtl, ledgerEntriesTtl } = meta;
  return {
    // `Ttl.None` keeps nothing past the next sweep: the cutoff is now
    auditLogRetention:
      auditLogTtl === Ttl.Forever
        ? undefined
        : auditLogTtl === Ttl.None
          ? (0 as Milliseconds)
          : auditLogTtl,
    ledgerEntryRetention: ledgerEntriesTtl === Ttl.Forever ? undefined : ledgerEntriesTtl,
  };
}

// --- the options an application declared, as the decorator normalizes them ----------------------

/** What an application's options were before its `storage` was turned into providers. */
const originals = new WeakMap<object, object>();
const owners = new WeakMap<object, ReadonlySet<Class>>();

/** The options as the application wrote them (themselves when it has no `storage`). */
export const declaredOptionsOf = <TOptions extends object>(options: TOptions): TOptions =>
  (originals.get(options) as TOptions | undefined) ?? options;

/** The store classes the application's storage components provide: no listed class reads the environment for them. */
export const storageOwnedClassesOf = (options: object): ReadonlySet<Class> =>
  owners.get(options) ?? new Set();

/**
 * `options` with the storage components' stores listed in `providers`, before the application's own
 * (its clock, its model providers): everything downstream reads one list. Without `storage` the
 * options as they are.
 */
export function withStorageProviders<
  TOptions extends { readonly storage?: unknown; readonly providers?: readonly Provider[] },
>(options: TOptions): TOptions {
  const storage = assembledStorageOf(options.storage);
  if (storage === undefined) return options;
  const { providers, owned } = storageProvidersOf(storage);
  const merged = { ...options, providers: [...providers, ...(options.providers ?? [])] };
  originals.set(merged, options);
  owners.set(merged, owned);
  return merged;
}
