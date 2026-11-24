/**
 * #1321a / #1324c: `@Application({ storage })` — the three storage components with their drivers
 * replace the stores in `providers`: the stores, the ttls, the secrets, the rules and the run on a
 * SQLite file the driver names.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EmptyEnvironment } from "../../src/index.js";
import { applicationIdempotencyKeysOf } from "../../src/application/idempotency-key.js";
import { applicationPiiKeyOf } from "../../src/application/application-pii.js";
import { describedApplicationOf } from "../../src/describe/application.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import {
  ClusterStorage,
  DatabaseStorage,
  InMemoryDatabaseStorage,
  InMemoryObjectDriver,
  LocalDiskDriver,
  ObjectStorage,
  S3Driver,
  SqliteDriver,
  SqliteExecutionLeaseRepository,
  SqliteCostLedgerRepository,
  SqliteCheckpointSaver,
  Ttl,
} from "../../src/index.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { storageProvidersOf, assembledStorageOf } from "../../src/storage/storage-assembly.js";
import { defineStorageDriver, StorageRole } from "../../src/stores/index.js";
import { defineEnv, env, secret } from "../../src/environments/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { days, hours, seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import { NoteWorkflow } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "../infrastructure/sqlite/fixtures/environments/app.environment.js";

const folder = mkdtempSync(join(tmpdir(), "agboss-storage-test-"));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});
const FILE = join(folder, "storage.sqlite");

@DatabaseStorage({
  driver: SqliteDriver({ path: FILE }),
  auditLogTtl: days(90),
  ledgerEntriesTtl: days(30),
})
class FileDatabaseStorage {}

@Application({
  name: "storage-file-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NoteWorkflow],
  budgets: TEST_BUDGETS,
  storage: FileDatabaseStorage,
})
class StorageFileApplication {}

const violationsOf = async (application: new () => unknown): Promise<readonly string[]> => {
  try {
    await applicationOf(application);
    return [];
  } catch (error) {
    if (error instanceof GraphRuleError) return error.violations.map((one) => one.code);
    throw error;
  }
};

describe("storage components", () => {
  it("assemble into the drivers' stores, before the application's own providers", async () => {
    const assembled = await applicationOf(StorageFileApplication);

    expect(assembled.providers).toContain(SqliteExecutionLeaseRepository);
    expect(assembled.providers).toContain(SqliteCostLedgerRepository);
    expect(assembled.providers).toContain(SqliteCheckpointSaver);
    expect(assembled.storage?.database?.meta.name).toBe("file-database-storage");
  });

  it("keep the audit log and the ledger entries by the database's ttls", async () => {
    const assembled = await applicationOf(StorageFileApplication);

    expect(assembled.auditLogRetention).toBe(days(90));
    expect(assembled.ledgerEntryRetention).toBe(days(30));
  });

  it("Ttl.Forever is never swept and Ttl.None is swept at once", async () => {
    @DatabaseStorage({
      driver: SqliteDriver({ path: FILE }),
      auditLogTtl: Ttl.None,
      ledgerEntriesTtl: Ttl.Forever,
    })
    class OddStorage {}
    @Application({
      name: "odd-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: OddStorage,
    })
    class OddApplication {}

    const assembled = await applicationOf(OddApplication);

    expect(assembled.auditLogRetention).toBe(0);
    expect(assembled.ledgerEntryRetention).toBeUndefined();
  });

  it("InMemoryDatabaseStorage lists no store: the built-in defaults", async () => {
    @Application({
      name: "memory-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: InMemoryDatabaseStorage,
    })
    class MemoryApplication {}

    const assembled = await applicationOf(MemoryApplication);

    expect(assembled.providers).toEqual([]);
    expect(assembled.auditLogRetention).toBe(hours(24));
  });

  it("a cluster takes the leases, the child queue and the rate limits; the database keeps the rest", () => {
    class ClusterLease {
      readonly isLease = true;
    }
    const driver = defineStorageDriver({
      role: StorageRole.Cluster,
      backend: "fake",
      describes: "fake",
      settings: { kind: "fake" },
      providers: [ClusterLease as never],
    });
    @ClusterStorage({ driver })
    class FakeCluster {}

    const storage = assembledStorageOf({ database: FileDatabaseStorage, cluster: FakeCluster });
    const { providers } = storageProvidersOf(storage ?? {});

    expect(providers).not.toContain(SqliteExecutionLeaseRepository);
    expect(providers).toContain(SqliteCostLedgerRepository);
    expect(providers).toContain(ClusterLease);
    // the cluster's lease keeps its execution ids in the database's lease row
    expect(providers.some((p) => typeof p === "object" && "useClass" in p)).toBe(true);
  });
});

describe("storage rules", () => {
  it("a store class listed beside the storage is [storage.providers-conflict]", async () => {
    @Application({
      name: "conflict-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: FileDatabaseStorage,
      providers: [SqliteExecutionLeaseRepository],
    })
    class ConflictApplication {}

    expect(await violationsOf(ConflictApplication)).toEqual(["storage.providers-conflict"]);
  });

  it("retention.auditLog beside the storage is [storage.retention-conflict]", async () => {
    @Application({
      name: "retention-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: FileDatabaseStorage,
      retention: { auditLog: hours(2) },
    })
    class RetentionApplication {}

    expect(await violationsOf(RetentionApplication)).toEqual(["storage.retention-conflict"]);
  });

  it("a class with no storage decorator is [storage.not-a-storage]", async () => {
    class Plain {
      readonly isPlain = true;
    }
    @Application({
      name: "plain-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: Plain,
    })
    class PlainApplication {}

    expect(await violationsOf(PlainApplication)).toContain("storage.not-a-storage");
  });

  it("a ledger ttl at or below the lease is [storage.ttl-invalid]", async () => {
    @DatabaseStorage({
      driver: SqliteDriver({ path: FILE }),
      auditLogTtl: days(1),
      ledgerEntriesTtl: seconds(30),
    })
    class ShortStorage {}
    @Application({
      name: "short-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: ShortStorage,
    })
    class ShortApplication {}

    expect(await violationsOf(ShortApplication)).toEqual(["storage.ttl-invalid"]);
  });

  it("Ttl.None for the ledger entries is [storage.ttl-invalid]", async () => {
    @DatabaseStorage({
      driver: SqliteDriver({ path: FILE }),
      auditLogTtl: days(1),
      ledgerEntriesTtl: Ttl.None as never,
    })
    class NoneStorage {
      readonly isNone = true;
    }
    @Application({
      name: "none-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: NoneStorage,
    })
    class NoneApplication {}

    expect(await violationsOf(NoneApplication)).toEqual(["storage.ttl-invalid"]);
  });

  it("a cluster over a database with no durable lease rows is refused", async () => {
    const driver = defineStorageDriver({
      role: StorageRole.Cluster,
      backend: "fake",
      describes: "fake",
      settings: { kind: "fake" },
      providers: [],
    });
    @ClusterStorage({ driver })
    class AnyCluster {}
    @Application({
      name: "volatile-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: { database: InMemoryDatabaseStorage, cluster: AnyCluster },
    })
    class VolatileApplication {}

    expect(await violationsOf(VolatileApplication)).toEqual([
      "storage.cluster-needs-durable-lease-store",
    ]);
  });

  it("two storage secrets on one variable are [storage.secret-shared]", async () => {
    @DatabaseStorage({
      driver: SqliteDriver({ path: FILE }),
      auditLogTtl: days(1),
      ledgerEntriesTtl: days(1),
      idempotencySecret: secret("ONE_KEY"),
      piiSecret: secret("ONE_KEY"),
    })
    class SharedStorage {}
    @Application({
      name: "shared-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: SharedStorage,
    })
    class SharedApplication {}

    expect(await violationsOf(SharedApplication)).toEqual(["storage.secret-shared"]);
  });

  it("a driver of another role is [storage.driver-invalid]", async () => {
    @DatabaseStorage({
      driver: InMemoryObjectDriver() as never,
      auditLogTtl: days(1),
      ledgerEntriesTtl: days(1),
    })
    class WrongStorage {}
    @Application({
      name: "wrong-storage-application",
      version: "1.0.0",
      environment: SqliteTestEnvironment,
      workflows: [NoteWorkflow],
      budgets: TEST_BUDGETS,
      storage: WrongStorage,
    })
    class WrongApplication {}

    expect(await violationsOf(WrongApplication)).toContain("storage.driver-invalid");
  });
});

describe("drivers", () => {
  it("S3Driver, LocalDiskDriver and InMemoryObjectDriver provide their file store", () => {
    expect(InMemoryObjectDriver().providers).toEqual([InMemoryA2AFileRepository]);
    expect(LocalDiskDriver({ directory: "/tmp/x" }).describes).toBe("local disk /tmp/x");
    expect(S3Driver({ bucket: "files" }).describes).toBe("s3 files");
  });

  it("SqliteDriver.inMemory() names one temporary file, made once", () => {
    const driver = SqliteDriver.inMemory();
    const first = driver.settings.path;
    const second = driver.settings.path;

    expect(first).toBe(second);
    expect(String(first)).toContain("agboss-sqlite-");
  });

  it("a driver's settings keep their references until the application starts", () => {
    const appEnv = defineEnv({ path: env("STORAGE_TEST_PATH") });
    const driver = SqliteDriver({ path: appEnv.path });

    expect(driver.describes).toBe("sqlite (STORAGE_TEST_PATH)");
  });
});

describe("an application on a SQLite storage", () => {
  const test = testWith(StorageFileApplication);

  test("runs on the file the driver names, with no environment field", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));

    const result = await execute(app, OrderWorkflowStart, { text: "note one" });

    expect(result.status).toBeDefined();
    expect(existsSync(FILE)).toBe(true);
  });
});

describe("the storage's secrets", () => {
  @DatabaseStorage({
    driver: SqliteDriver({ path: FILE }),
    auditLogTtl: days(1),
    ledgerEntriesTtl: days(1),
    idempotencySecret: secret("STORAGE_TEST_IDEMPOTENCY"),
    previousIdempotencySecret: secret.optional("STORAGE_TEST_PREVIOUS"),
    piiSecret: secret("STORAGE_TEST_PII"),
  })
  class KeyedStorage {
    readonly isKeyed = true;
  }
  @Application({
    name: "keyed-storage-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [NoteWorkflow],
    budgets: TEST_BUDGETS,
    storage: KeyedStorage,
  })
  class KeyedApplication {}

  it("are the application's idempotency keys, read from the process when it starts", async () => {
    const assembled = await applicationOf(KeyedApplication);

    expect(
      applicationIdempotencyKeysOf(assembled, {} as never, {
        STORAGE_TEST_IDEMPOTENCY: "one",
        STORAGE_TEST_PREVIOUS: "zero",
      }),
    ).toEqual({ fingerprintKeys: { current: "one", previous: "zero" } });
    expect(
      applicationIdempotencyKeysOf(assembled, {} as never, { STORAGE_TEST_IDEMPOTENCY: "one" }),
    ).toEqual({ fingerprintKeys: { current: "one" } });
  });

  it("fail the start, naming the variable and never a value, when one is not set", async () => {
    const assembled = await applicationOf(KeyedApplication);

    expect(() => applicationIdempotencyKeysOf(assembled, {} as never, {})).toThrow(
      "STORAGE_TEST_IDEMPOTENCY is not set",
    );
  });

  it("are the application's PII key", async () => {
    const assembled = await applicationOf(KeyedApplication);

    expect(
      applicationPiiKeyOf(assembled, {
        environment: {} as never,
        env: { STORAGE_TEST_PII: "pii" },
      }),
    ).toEqual({ key: "pii", isInstanceKey: false });
  });
});

describe("agboss describe", () => {
  it("lists each storage component with its driver", async () => {
    const assembled = await applicationOf(StorageFileApplication);

    expect(describedApplicationOf(assembled).storage).toEqual([
      {
        role: "database",
        name: "file-database-storage",
        backend: "sqlite",
        describes: `sqlite ${FILE}`,
      },
    ]);
  });
});
