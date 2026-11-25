import { recordOptionKeys } from "../components/option-keys.js";
import {
  CLUSTER_STORAGE_KEYS,
  DATABASE_STORAGE_KEYS,
  OBJECT_STORAGE_KEYS,
} from "../components/decorator-options.js";
import type { Class } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import type { OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import { resolvedName } from "../flow/names.js";
import type { Milliseconds, Ttl } from "../units/index.js";
import type { ClusterDriver, DatabaseDriver, ObjectDriver, StorageRole } from "./storage-driver.js";

/**
 * The three storage components (#1321, #1324): a class decorated with where an application's rows
 * go, listed once in `@Application({ storage })`. Each holds one driver (`SqliteDriver`,
 * `PostgresDriver`, `RedisDriver`, `S3Driver`, …) — its connection settings, with `env(…)` /
 * `secret(…)` references that are read when the application starts — so `@Application` itself
 * carries no host, password or bucket.
 */

/** `@DatabaseStorage` options. */
export interface DatabaseStorageOptions {
  /** Kebab-case; the class name in kebab-case when left out. */
  readonly name?: string;
  readonly description?: string;
  /** Where the durable rows go: `SqliteDriver({ path })`, `PostgresDriver({ url })`, … */
  readonly driver: DatabaseDriver;
  /**
   * How long a row of the audit log is kept after it happened: every takeover of a tree's lease and
   * every step handed over. `Ttl.Forever` is never removed; `Ttl.None` keeps nothing past the next
   * sweep. Required: a log kept by a default nobody chose is a decision nobody made.
   */
  readonly auditLogTtl: Milliseconds | Ttl.Forever | Ttl.None;
  /**
   * How long an entry of the cost ledger is kept after its spend was made — only the entry that
   * makes a retried write count once; the counters of a budget's period are never removed. Above
   * the lease's 30 s, so that a retried write is still refused, never counted twice. Required.
   */
  readonly ledgerEntriesTtl: Milliseconds | Ttl.Forever;
  /**
   * The key of the business-key fingerprints of `Idempotency` (HMAC): the same on every instance,
   * never the PII key or a provider's. Required as soon as a component can write under a business
   * key.
   */
  readonly idempotencySecret?: SecretRef;
  /** The key `idempotencySecret` rotates from: a fingerprint recorded under it is still recognised. */
  readonly previousIdempotencySecret?: SecretRef | OptionalSecretRef;
  /**
   * The application's PII key: tokens of `sensitive` fields and of any policy without its own key
   * are made with it, so one value is one token on every instance. Required as soon as anything
   * tokenizes (`[pii.secret-required]`); no storage supplies a key (a test's `testWith` has its own).
   */
  readonly piiSecret?: SecretRef;
  /** The key `piiSecret` rotates from: a token made under it is kept in a thread that holds it. */
  readonly previousPiiSecret?: SecretRef | OptionalSecretRef;
}

/** `@ClusterStorage` options. */
export interface ClusterStorageOptions {
  readonly name?: string;
  readonly description?: string;
  /** Where the rows that coordinate instances go: leases, the child queue, rate limits. */
  readonly driver: ClusterDriver;
}

/** `@ObjectStorage` options. */
export interface ObjectStorageOptions {
  readonly name?: string;
  readonly description?: string;
  /** Where the files go: `S3Driver({ bucket })`, `LocalDiskDriver({ directory })`, … */
  readonly driver: ObjectDriver;
}

/** What `@DatabaseStorage` recorded: its options, with the name resolved. */
export type DatabaseStorageMeta = Omit<DatabaseStorageOptions, "name"> & { readonly name: string };
/** What `@ClusterStorage` recorded. */
export type ClusterStorageMeta = Omit<ClusterStorageOptions, "name"> & { readonly name: string };
/** What `@ObjectStorage` recorded. */
export type ObjectStorageMeta = Omit<ObjectStorageOptions, "name"> & { readonly name: string };

const named = <TOptions extends { readonly name?: string | undefined }>(
  options: TOptions,
  value: Class,
): TOptions & { readonly name: string } => ({
  ...options,
  name: resolvedName(options.name, value),
});

/** The place of the application's durable rows: `@DatabaseStorage({ driver, auditLogTtl, ledgerEntriesTtl })`. */
export function DatabaseStorage(options: DatabaseStorageOptions) {
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "DatabaseStorage", options, DATABASE_STORAGE_KEYS);
    recordComponent(value, { kind: "database-storage", meta: named(options, value) });
    return value;
  };
}

/** The place of the rows that coordinate instances: `@ClusterStorage({ driver })`. */
export function ClusterStorage(options: ClusterStorageOptions) {
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "ClusterStorage", options, CLUSTER_STORAGE_KEYS);
    recordComponent(value, { kind: "cluster-storage", meta: named(options, value) });
    return value;
  };
}

/** The place of the files: `@ObjectStorage({ driver })`. */
export function ObjectStorage(options: ObjectStorageOptions) {
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "ObjectStorage", options, OBJECT_STORAGE_KEYS);
    recordComponent(value, { kind: "object-storage", meta: named(options, value) });
    return value;
  };
}

/** What `@DatabaseStorage` recorded on a class; `undefined` for any other class. */
export function databaseStorageOf(cls: Class): DatabaseStorageMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "database-storage" ? component.meta : undefined;
}

/** What `@ClusterStorage` recorded on a class. */
export function clusterStorageOf(cls: Class): ClusterStorageMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "cluster-storage" ? component.meta : undefined;
}

/** What `@ObjectStorage` recorded on a class. */
export function objectStorageOf(cls: Class): ObjectStorageMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "object-storage" ? component.meta : undefined;
}

/** The role a decorator is for, as a message names it. */
export const DECORATOR_OF: Readonly<Record<StorageRole, string>> = {
  database: "@DatabaseStorage",
  cluster: "@ClusterStorage",
  objects: "@ObjectStorage",
};
