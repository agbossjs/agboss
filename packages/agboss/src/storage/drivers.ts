import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../environments/env-readers.js";
import type { EnvRef, SecretRef } from "../environments/env-ref.js";
import { secret } from "../environments/secret.js";
import { InMemoryFileRepository } from "../infrastructure/in-memory-file.repository.js";
import { LocalDiskFileRepository } from "../infrastructure/local-disk-file.repository.js";
import { S3FileRepository } from "../infrastructure/s3/s3-file.repository.js";
import { SqliteA2ADirectMessageRepository } from "../infrastructure/sqlite/sqlite-a2a-direct-message.repository.js";
import { SqliteA2ATaskRepository } from "../infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { SqliteCheckpointSaver } from "../infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { SqliteChildExecutionQueueRepository } from "../infrastructure/sqlite/sqlite-child-execution-queue.repository.js";
import { SqliteCostLedgerRepository } from "../infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import {
  SqliteExecutionAuditLogRepository,
  SqliteExecutionLeaseRepository,
} from "../infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteExecutionHistoryRepository } from "../infrastructure/sqlite/sqlite-execution-history.repository.js";
import { SqliteExecutionRecordRepository } from "../infrastructure/sqlite/sqlite-execution-record.repository.js";
import { SqliteExecutionTreeRepository } from "../infrastructure/sqlite/sqlite-execution-tree.repository.js";
import { SqliteFencedEffectRepository } from "../infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { SqliteMeshRequestRepository } from "../infrastructure/sqlite/sqlite-mesh-request.repository.js";
import { SqliteOutboundCallRepository } from "../infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { SqlitePausedExecutionRepository } from "../infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { SqliteRateLimitRepository } from "../infrastructure/sqlite/sqlite-rate-limit.repository.js";
import {
  defineStorageDriver,
  StorageRole,
  type DatabaseDriver,
  type ObjectDriver,
} from "./storage-driver.js";

/**
 * The drivers the core ships (#1321): `SqliteDriver` for a database, `S3Driver`, `LocalDiskDriver` and
 * `InMemoryObjectDriver` for files. `@agboss/postgres`, `@agboss/mongodb` and `@agboss/redis` ship
 * theirs (`PostgresDriver`, `MongoDriver`, `RedisDriver`) with `defineStorageDriver`.
 */

/** `SqliteDriver({ path })` options. */
export interface SqliteDriverOptions {
  /** The database file; its folder is created. */
  readonly path: string | EnvRef<string>;
}

/** Every SQLite store, over the one connection of the database storage. */
const SQLITE_STORES = [
  SqliteCheckpointSaver,
  SqliteExecutionRecordRepository,
  SqliteCostLedgerRepository,
  SqlitePausedExecutionRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionTreeRepository,
  SqliteRateLimitRepository,
  SqliteMeshRequestRepository,
  SqliteA2ATaskRepository,
  SqliteA2ADirectMessageRepository,
  SqliteExecutionHistoryRepository,
  SqliteChildExecutionQueueRepository,
  SqliteFencedEffectRepository,
  SqliteExecutionAuditLogRepository,
  SqliteOutboundCallRepository,
] as const;

const sqlite = (
  path: string | EnvRef<string> | (() => string),
  describes: string,
): DatabaseDriver => {
  const settings: Record<string, unknown> = { kind: "sqlite" };
  if (typeof path === "function") {
    // a getter: the file is made once, by the first instance that resolves the settings
    Object.defineProperty(settings, "path", { enumerable: true, get: path });
  } else settings.path = path;
  return defineStorageDriver({
    role: StorageRole.Database,
    backend: "sqlite",
    describes,
    settings: settings as { readonly kind: string },
    providers: SQLITE_STORES,
    leaseStore: SqliteExecutionLeaseRepository,
    coordinationStores: [
      SqliteExecutionLeaseRepository,
      SqliteChildExecutionQueueRepository,
      SqliteRateLimitRepository,
    ],
  });
};

/** The temporary folders made for `SqliteDriver.inMemory()`: removed when the process ends. */
const temporary: string[] = [];
let isCleaning = false;

function temporaryFile(): string {
  const folder = mkdtempSync(join(tmpdir(), "agboss-sqlite-"));
  temporary.push(folder);
  if (!isCleaning) {
    isCleaning = true;
    process.once("exit", () => {
      for (const each of temporary) rmSync(each, { recursive: true, force: true });
    });
  }
  return join(folder, "agboss.db");
}

/**
 * The database in a SQLite file (`node:sqlite`): every store of the application on one connection;
 * two instances open two connections to one file.
 */
export function SqliteDriver(options: SqliteDriverOptions): DatabaseDriver {
  const { path } = options;
  return sqlite(path, typeof path === "string" ? `sqlite ${path}` : `sqlite (${path.variable})`);
}

/**
 * A SQLite database in a temporary file, shared by every instance made from this driver — a test's
 * second instance, `recoverApp()` — and removed when the process ends. Not for production: it does
 * not outlive the process.
 */
SqliteDriver.inMemory = (): DatabaseDriver => {
  let file: string | undefined;
  return sqlite(() => (file ??= temporaryFile()), "sqlite (a temporary file)");
};

/** `S3Driver({ bucket })` options. */
export interface S3DriverOptions {
  readonly bucket: string | EnvRef<string>;
  /** Default: `AWS_REGION` of the process. */
  readonly region?: string | EnvRef<string>;
  /** An S3-compatible endpoint (`https://minio.internal:9000`); none: AWS. */
  readonly endpoint?: string | EnvRef<string>;
  /** Default: `AWS_ACCESS_KEY_ID` of the process. */
  readonly accessKeyId?: SecretRef;
  /** Default: `AWS_SECRET_ACCESS_KEY` of the process. */
  readonly secretAccessKey?: SecretRef;
  /** The key prefix every object is under; default `agboss-a2a-files/`. */
  readonly prefix?: string | EnvRef<string>;
}

const defined = (options: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));

/** The files in an S3 bucket (or an S3-compatible store), signed with Signature Version 4. */
export function S3Driver(options: S3DriverOptions): ObjectDriver {
  const { bucket } = options;
  return defineStorageDriver({
    role: StorageRole.Objects,
    backend: "s3",
    describes: `s3 ${typeof bucket === "string" ? bucket : `(${bucket.variable})`}`,
    // what the options leave out is read from the process's own AWS variables, at start
    settings: {
      kind: "s3",
      region: env("AWS_REGION"),
      accessKeyId: secret("AWS_ACCESS_KEY_ID"),
      secretAccessKey: secret("AWS_SECRET_ACCESS_KEY"),
      ...defined(options),
    },
    providers: [S3FileRepository],
  });
}

/** `LocalDiskDriver({ directory })` options. */
export interface LocalDiskDriverOptions {
  /** The folder the files are kept in (one host). */
  readonly directory: string | EnvRef<string>;
}

/** The files in a folder of one host: a single-host store. */
export function LocalDiskDriver(options: LocalDiskDriverOptions): ObjectDriver {
  const { directory } = options;
  return defineStorageDriver({
    role: StorageRole.Objects,
    backend: "local-disk",
    describes: `local disk ${typeof directory === "string" ? directory : `(${directory.variable})`}`,
    settings: { kind: "local-disk", directory },
    providers: [LocalDiskFileRepository],
  });
}

/** The files in memory: lost with the process, not shared by instances. For tests. */
export function InMemoryObjectDriver(): ObjectDriver {
  return defineStorageDriver({
    role: StorageRole.Objects,
    backend: "in-memory",
    describes: "in memory",
    settings: { kind: "in-memory" },
    providers: [InMemoryFileRepository],
  });
}
