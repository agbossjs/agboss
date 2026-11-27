/**
 * #1324b: a fault store set may name the settings of a cluster storage beside its database — the
 * pod then declares a `@ClusterStorage` of them, and the stores on that backend are the cluster's.
 */
import { describe, expect, it } from "vitest";
import { storageViolations } from "../../src/storage/storage-rules.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { driverOf } from "../../src/storage/storage-assembly.js";
import { clusterStorageOf, databaseStorageOf } from "../../src/storage/storage-decorators.js";
import { StorageRole } from "../../src/storage/storage-driver.js";
import { env, secret } from "../../src/index.js";
import { faultStorageOf } from "../../src/testing/faults/fixture/fault.application.js";
import type { FaultStoreSet } from "../../src/testing/faults/index.js";
import { faultStores } from "../faults/sqlite.fault-stores.js";

class RedisQueueStore {
  static readonly store = { backend: "redis" };
  readonly kind = "redis-queue";
}

const withCluster: FaultStoreSet = {
  ...faultStores,
  providers: [...faultStores.providers, RedisQueueStore],
  storage: {
    ...faultStores.storage,
    cluster: {
      kind: "redis",
      url: secret("AGBOSS_FAULT_REDIS_URL"),
      keyPrefix: env("AGBOSS_FAULT_REDIS_PREFIX"),
    },
  },
};

describe("#1324b: FaultStorage.cluster", () => {
  it("none: one database storage, as before", () => {
    const storage = faultStorageOf(faultStores);

    if (typeof storage !== "function") throw new Error("one class expected");
    expect(databaseStorageOf(storage)).toBeDefined();
  });

  it("given: a database and a cluster storage with the cluster's settings", () => {
    const storage = faultStorageOf(withCluster);
    if (typeof storage === "function" || storage.cluster === undefined)
      throw new Error("a database and a cluster expected");

    const clusterDriver = driverOf(clusterStorageOf(storage.cluster), StorageRole.Cluster);
    const databaseDriver = driverOf(databaseStorageOf(storage.database), StorageRole.Database);

    expect(clusterDriver?.backend).toBe("redis");
    expect(clusterDriver?.settings).toMatchObject({ kind: "redis" });
    expect(clusterDriver?.providers).toEqual([RedisQueueStore]);
    expect(databaseDriver?.backend).toBe("sqlite");
    expect(databaseDriver?.providers).not.toContain(RedisQueueStore);
  });

  // #1324: every fault pod with a cluster died with [storage.cluster-needs-durable-lease-store]
  it("given: the database driver keeps the set's durable lease store, so the storage rules pass", () => {
    const storage = faultStorageOf(withCluster);
    if (typeof storage === "function") throw new Error("a database and a cluster expected");

    const databaseDriver = driverOf(databaseStorageOf(storage.database), StorageRole.Database);

    expect(databaseDriver?.leaseStore?.prototype).toBeInstanceOf(ExecutionLeaseRepository);
    expect(databaseDriver?.providers).toContain(databaseDriver?.leaseStore);
    expect(storageViolations("FaultApplication", { storage })).toEqual([]);
  });

  it("none: no cluster, no lease store of the driver's own (the set's stores stay as listed)", () => {
    const storage = faultStorageOf(faultStores);
    if (typeof storage !== "function") throw new Error("one class expected");

    expect(driverOf(databaseStorageOf(storage), StorageRole.Database)?.leaseStore).toBeUndefined();
  });
});
