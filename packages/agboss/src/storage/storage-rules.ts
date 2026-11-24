import type { Provider } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { secretViolations, type KeyFields } from "./storage-secret-rules.js";
import { ttlProblemOf } from "./ttl-problem.js";
import { infrastructureContractOf } from "../infrastructure/contracts.js";
import { Ttl } from "../units/index.js";
import {
  assembledStorageOf,
  classOf,
  declaredOf,
  declaredOptionsOf,
  driverOf,
  isFunction,
  type AssembledStorage,
} from "./storage-assembly.js";
import {
  clusterStorageOf,
  databaseStorageOf,
  DECORATOR_OF,
  objectStorageOf,
} from "./storage-decorators.js";
import { StorageRole } from "./storage-driver.js";

/** What a store contract's own name is called in a message, for the contracts storage never owns. */
const NOT_STORAGE = new Set(["Clock", "IdGenerator", "Logger", "FileTranscriber", "FileRedactor"]);

const nameOf = (value: unknown): string =>
  isFunction(value) ? value.name || "(anonymous class)" : typeof value;

/** The slot `storage` puts each component in: a database, and decorated classes. */
function slotViolations(application: string, storage: unknown): RuleViolation[] {
  const declared = declaredOf(storage);
  const found: RuleViolation[] = [];
  if (declared.database === undefined)
    found.push(
      violation(
        "storage.database-required",
        `${application}'s storage names no database — storage: { database: AppDatabaseStorage }, or the class itself`,
        [application],
      ),
    );
  const slots = [
    [StorageRole.Database, declared.database, databaseStorageOf],
    [StorageRole.Cluster, declared.cluster, clusterStorageOf],
    [StorageRole.Objects, declared.objects, objectStorageOf],
  ] as const;
  for (const [role, cls, recorded] of slots) {
    if (cls === undefined || (isFunction(cls) && recorded(cls) !== undefined)) continue;
    found.push(
      violation(
        "storage.not-a-storage",
        `${nameOf(cls)} in ${application}'s storage.${role} has no ${DECORATOR_OF[role]}({ driver }) decorator`,
        [application],
      ),
    );
  }
  return found;
}

/** Each component's driver is one made for its role. */
function driverViolations(application: string, storage: AssembledStorage): RuleViolation[] {
  const entries = [
    [StorageRole.Database, storage.database],
    [StorageRole.Cluster, storage.cluster],
    [StorageRole.Objects, storage.objects],
  ] as const;
  return entries.flatMap(([role, entry]) =>
    entry === undefined || driverOf(entry.meta, role) !== undefined
      ? []
      : [
          violation(
            "storage.driver-invalid",
            `${entry.cls.name}'s driver is no ${role} driver — ${DECORATOR_OF[role]}({ driver }) takes what a ${role} driver's factory returns`,
            [application],
          ),
        ],
  );
}

/** A cluster has a durable database lease store to keep its ids and cancel marks in. */
function clusterViolations(application: string, storage: AssembledStorage): RuleViolation[] {
  const { cluster, database } = storage;
  if (cluster === undefined) return [];
  const driver = driverOf(database?.meta, StorageRole.Database);
  if (driver === undefined || driver.leaseStore !== undefined) return [];
  return [
    violation(
      "storage.cluster-needs-durable-lease-store",
      `${cluster.cls.name} is the cluster, but ${database?.cls.name ?? "the database"}'s driver keeps no durable lease rows (${driver.backend}): a cluster's leases keep their execution ids and cancel marks in the database — use a database driver that does (SqliteDriver, PostgresDriver, MongoDriver)`,
      [application],
    ),
  ];
}

/** One ttl: a duration in range, or one of the `Ttl` values it takes. */
function ttlOrValueProblemOf(value: unknown, allowed: readonly Ttl[], isAboveLease: boolean) {
  if (typeof value === "string")
    return (allowed as readonly string[]).includes(value)
      ? undefined
      : `is "${value}", which this ttl does not take`;
  if (value === undefined) return "is required — a duration, or Ttl.Forever";
  return ttlProblemOf(value, isAboveLease);
}

/** The two ttls: durations in range, the ledger's above the lease, `Ttl.None` for the audit log only. */
function ttlViolations(application: string, storage: AssembledStorage): RuleViolation[] {
  const entry = storage.database;
  if (entry === undefined) return [];
  const checks = [
    ["auditLogTtl", ttlOrValueProblemOf(entry.meta.auditLogTtl, [Ttl.Forever, Ttl.None], false)],
    ["ledgerEntriesTtl", ttlOrValueProblemOf(entry.meta.ledgerEntriesTtl, [Ttl.Forever], true)],
  ] as const;
  return checks.flatMap(([field, problem]) =>
    problem === undefined
      ? []
      : [violation("storage.ttl-invalid", `${entry.cls.name}.${field} ${problem}`, [application])],
  );
}

/** The storage's drivers own the stores: a listed store class is a second implementation of one. */
function conflictViolations(
  application: string,
  storage: AssembledStorage,
  listed: readonly Provider[],
): RuleViolation[] {
  return listed.flatMap((provider) => {
    const cls = classOf(provider);
    const contract = cls === undefined ? undefined : infrastructureContractOf(cls);
    if (cls === undefined || contract === undefined || NOT_STORAGE.has(contract.name)) return [];
    // files: the objects' to name, only when the application declares them
    if (contract.name === "A2AFileRepository" && storage.objects === undefined) return [];
    return [
      violation(
        "storage.providers-conflict",
        `${cls.name} (${contract.name}) is listed in ${application}'s providers beside its storage — the storage components provide the stores: remove it, and choose it in the component's driver`,
        [application],
      ),
    ];
  });
}

/** Every violation of an application's `storage`: its shape, its drivers, its ttls, its keys, its providers. */
export function storageViolations(
  application: string,
  options: KeyFields & {
    readonly storage?: unknown;
    readonly providers?: readonly Provider[];
    readonly retention?: unknown;
  },
): RuleViolation[] {
  if (options.storage === undefined) return [];
  const own = declaredOptionsOf(options);
  const storage = assembledStorageOf(options.storage) ?? {};
  const retention = own.retention;
  const clashes = ["auditLog", "costLedgerEntries"].filter(
    (field) => typeof retention === "object" && retention !== null && field in retention,
  );
  return [
    ...slotViolations(application, options.storage),
    ...driverViolations(application, storage),
    ...clusterViolations(application, storage),
    ...ttlViolations(application, storage),
    ...secretViolations(application, storage, own),
    ...conflictViolations(application, storage, own.providers ?? []),
    ...clashes.map((field) =>
      violation(
        "storage.retention-conflict",
        `@Application({ retention: { ${field} } }) is set beside storage: ${field === "auditLog" ? "auditLogTtl" : "ledgerEntriesTtl"} of the @DatabaseStorage is where it is kept now`,
        [application],
      ),
    ),
  ];
}
