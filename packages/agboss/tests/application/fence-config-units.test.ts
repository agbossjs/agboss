/**
 * #1366 (shard `fence-config`): the assembly's pairing of a fencing store with the application's lease store
 * (`implementations.ts`), read from the declarations alone — what each refusal says to the letter, the
 * stores that opt out, the lease store the pairing is made with — and the retentions that must stay above the
 * lease (`retention.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import {
  backendOf,
  hasTwoListed,
  leaseStoreOf,
  notAtomicStoresOf,
  storeBackendViolations,
} from "../../src/application/implementations.js";
import { retentionViolations } from "../../src/application/retention.js";
import { EXECUTION_LEASE } from "../../src/app/lease-fence.js";
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
  LeaseCheck,
  type StoreDescriptor,
} from "../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectRepository } from "../../src/infrastructure/fenced-effect.repository.js";
import {
  InMemoryFencedEffectRepository,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
} from "../../src/index.js";
import {
  BillingLeases,
  EmptyEffects,
  EmptyLeases,
  PostgresCalls,
  PostgresEffects,
  PostgresLeases,
  RedisLeases,
  UncheckedEffects,
  UncheckedRedisCalls,
  UndeclaredEffects,
  UndeclaredLeases,
} from "./fixtures/store-backends.fixture.js";
import { hours, minutes } from "../../src/units/index.js";

const HOW = 'static store = { backend: "postgres" }';

describe("#1366: what the pairing refuses, to the letter", () => {
  it("a fencing store that declares no backend: it opts out or declares one", () => {
    expect(storeBackendViolations("desk-app", [UndeclaredEffects, PostgresLeases])).toEqual([
      {
        code: "application.store-backend-undeclared",
        message: `UndeclaredEffects declares no backend: a fenced-effect store checks its leases in its own transaction, so it and its lease store declare the database they are in (${HOW}) and assembly checks it is one — or it opts out with static store = { backend, leaseCheck: LeaseCheck.WithoutDoubleChargeProtection }, losing that protection`,
        nodes: ["desk-app"],
      },
    ]);
  });

  it("a lease store that declares no backend: named with the store that needs it", () => {
    expect(storeBackendViolations("desk-app", [PostgresCalls, UndeclaredLeases])).toEqual([
      {
        code: "application.store-backend-undeclared",
        message: `UndeclaredLeases declares no backend: PostgresCalls, an outbound-call store, checks the application's leases in its own transaction, so the lease store declares the database it is in (${HOW})`,
        nodes: ["desk-app"],
      },
    ]);
  });

  it("an empty backend is none declared", () => {
    expect(storeBackendViolations("a", [EmptyEffects, PostgresLeases]).map((v) => v.code)).toEqual([
      "application.store-backend-undeclared",
    ]);
    expect(storeBackendViolations("a", [PostgresEffects, EmptyLeases]).map((v) => v.code)).toEqual([
      "application.store-backend-undeclared",
    ]);
    expect(backendOf(EmptyEffects)).toBeUndefined();
    expect(backendOf(PostgresEffects)).toBe("postgres");
    expect(backendOf(UndeclaredEffects)).toBeUndefined();
  });

  it("a store and a lease store on two backends: both named, with the core store of each when there is one", () => {
    expect(storeBackendViolations("desk-app", [PostgresEffects, RedisLeases])).toEqual([
      {
        code: "application.store-backend-mismatch",
        message:
          'PostgresEffects (backend "postgres") checks its leases in its own transaction, but the application\'s leases are in RedisLeases (backend "redis"): a lease taken over meanwhile would not stop its write — list it with a lease store declaring backend "postgres", or list a fenced-effect store declaring backend "redis" in its place',
        nodes: ["desk-app"],
      },
    ]);
  });

  it("a backend named like an Object property is no core store", () => {
    class Inherited extends InMemoryFencedEffectRepository {
      static override readonly store = { backend: "constructor" };
    }

    const [mismatch] = storeBackendViolations("a", [Inherited, PostgresLeases]);

    expect(mismatch?.message).toContain(
      'list it with a lease store declaring backend "constructor", or list a fenced-effect store declaring backend "postgres" in its place',
    );
  });

  it("a store of the same backend as the leases, one that is undeclared on both sides: no mismatch is added to an undeclared", () => {
    expect(storeBackendViolations("a", [PostgresEffects, PostgresLeases])).toEqual([]);
    expect(
      storeBackendViolations("a", [UndeclaredEffects, UndeclaredLeases]).map((v) => v.code),
    ).toEqual(["application.store-backend-undeclared", "application.store-backend-undeclared"]);
  });

  it("with no lease store listed the in-memory default is the one a store is paired with", () => {
    const [mismatch] = storeBackendViolations("a", [PostgresEffects]);

    expect(mismatch?.message).toContain("InMemoryExecutionLeaseRepository");
    expect(mismatch?.code).toBe("application.store-backend-mismatch");
    expect(storeBackendViolations("a", [InMemoryFencedEffectRepository])).toEqual([]);
  });

  it("a store that opts out of the atomic lease check is paired with nothing — on a backend or none", () => {
    expect(storeBackendViolations("a", [UncheckedEffects, PostgresLeases])).toEqual([]);
    expect(storeBackendViolations("a", [UncheckedRedisCalls, PostgresLeases])).toEqual([]);
  });

  it("two lease stores are two: named both, and no fencing store is paired with either", () => {
    expect(
      storeBackendViolations("desk-app", [PostgresLeases, BillingLeases, PostgresEffects]),
    ).toEqual([
      {
        code: "di.ambiguous-implementation",
        message:
          '2 listed classes are lease stores (ExecutionLeaseRepository): PostgresLeases (backend "postgres"), BillingLeases (backend "postgres:billing") — list one',
        nodes: ["desk-app"],
      },
    ]);
  });

  it("two A2A task stores are named like two lease stores", () => {
    class TasksA extends InMemoryA2ATaskRepository {
      static override readonly store = { backend: "postgres" };
    }
    class TasksB extends InMemoryA2ATaskRepository {}

    expect(storeBackendViolations("desk-app", [TasksA, TasksB])).toEqual([
      {
        code: "di.ambiguous-implementation",
        message:
          '2 listed classes are A2A task stores (A2ATaskRepository): TasksA (backend "postgres"), TasksB (backend "in-memory") — list one',
        nodes: ["desk-app"],
      },
    ]);
  });

  it("a value bound with provide(…) is no store, and a class listed twice is one", () => {
    expect(
      storeBackendViolations("a", [
        { provide: ExecutionLeaseRepository, useValue: 1 } as never,
        PostgresEffects,
        PostgresEffects,
        PostgresLeases,
      ]),
    ).toEqual([]);
  });
});

describe("#1366: the core's stores a hint names", () => {
  it.each([
    [
      [PostgresEffects],
      'a fenced-effect store declaring backend "in-memory" (InMemoryFencedEffectRepository)',
    ],
    [
      [PostgresEffects, SqliteExecutionLeaseRepository],
      'a fenced-effect store declaring backend "sqlite" (SqliteFencedEffectRepository)',
    ],
    [
      [PostgresCalls],
      'an outbound-call store declaring backend "in-memory" (InMemoryOutboundCallRepository)',
    ],
    [
      [PostgresCalls, SqliteExecutionLeaseRepository],
      'an outbound-call store declaring backend "sqlite" (SqliteOutboundCallRepository)',
    ],
  ] as const)("%j: the store to list in its place is named", (providers, named) => {
    const [mismatch] = storeBackendViolations("a", providers);

    expect(mismatch?.message).toContain(`, or list ${named} in its place`);
  });

  it.each([
    [InMemoryFencedEffectRepository, "in-memory", "InMemoryExecutionLeaseRepository"],
    [SqliteFencedEffectRepository, "sqlite", "SqliteExecutionLeaseRepository"],
  ] as const)(
    "%o on %s beside other leases: the core's lease store is named",
    (store, backend, name) => {
      const [mismatch] = storeBackendViolations("a", [store, PostgresLeases]);

      expect(mismatch?.message).toContain(
        `list it with a lease store declaring backend "${backend}" (${name}), or list`,
      );
    },
  );

  it("the contract class listed itself is a listed class of its contract", () => {
    expect(leaseStoreOf([ExecutionLeaseRepository])).toBe(ExecutionLeaseRepository);
    expect(hasTwoListed([ExecutionLeaseRepository, PostgresLeases], ExecutionLeaseRepository)).toBe(
      true,
    );
  });

  it("a provider that is no class is no store, whatever it is", () => {
    for (const provider of [
      null,
      undefined,
      "text",
      5,
      { provide: ExecutionLeaseRepository },
    ] as never[]) {
      expect(storeBackendViolations("a", [provider, PostgresEffects, PostgresLeases])).toEqual([]);
      expect(leaseStoreOf([provider])).toBe(InMemoryExecutionLeaseRepository);
      expect(notAtomicStoresOf([provider])).toEqual([]);
      expect(hasTwoListed([provider, provider], ExecutionLeaseRepository)).toBe(false);
    }
  });
});

describe("#1366: which lease store a pairing is made with", () => {
  it("the one listed, else the in-memory default; two listed: none is known", () => {
    expect(leaseStoreOf([PostgresLeases])).toBe(PostgresLeases);
    expect(leaseStoreOf([])).toBe(InMemoryExecutionLeaseRepository);
    expect(leaseStoreOf([PostgresEffects])).toBe(InMemoryExecutionLeaseRepository);
    expect(leaseStoreOf([PostgresLeases, BillingLeases])).toBeUndefined();
    expect(leaseStoreOf([PostgresLeases, PostgresLeases])).toBe(PostgresLeases);
  });

  it("two listed classes of a contract: yes — one, or none: no, a repeated one is one", () => {
    expect(hasTwoListed([PostgresLeases, BillingLeases], ExecutionLeaseRepository)).toBe(true);
    expect(hasTwoListed([PostgresLeases], ExecutionLeaseRepository)).toBe(false);
    expect(hasTwoListed([PostgresLeases, PostgresLeases], ExecutionLeaseRepository)).toBe(false);
    expect(hasTwoListed([], ExecutionLeaseRepository)).toBe(false);
    expect(hasTwoListed([PostgresEffects, PostgresLeases], FencedEffectRepository)).toBe(false);
    expect(hasTwoListed([PostgresEffects, UncheckedEffects], FencedEffectRepository)).toBe(true);
  });

  it("the stores that opt out of the atomic check, of the fencing contracts only", () => {
    expect(
      notAtomicStoresOf([PostgresEffects, UncheckedEffects, UncheckedRedisCalls, PostgresLeases]),
    ).toEqual([UncheckedEffects, UncheckedRedisCalls]);
    expect(notAtomicStoresOf([PostgresEffects, PostgresLeases])).toEqual([]);
    class UncheckedLease extends InMemoryExecutionLeaseRepository {
      static override readonly store: StoreDescriptor = {
        backend: "x",
        leaseCheck: LeaseCheck.WithoutDoubleChargeProtection,
      };
    }
    expect(notAtomicStoresOf([UncheckedLease])).toEqual([]);
  });
});

describe("#1366: a retention stays above the lease", () => {
  const lease = EXECUTION_LEASE;

  it.each(["fencedEffects", "outboundCalls", "costLedgerEntries", "a2aMessages"])(
    "%s at the lease or below is refused naming the lease's length; one ms above is not",
    (field) => {
      const [atLease] = retentionViolations("desk-app", { [field]: lease });
      expect(atLease).toEqual({
        code: "application.retention-invalid",
        message: `its retention.${field} is ${String(lease)} ms, not above the lease's ${String(lease)} ms — @Application({ retention: { ${field}: hours(24) } })`,
        nodes: ["desk-app"],
      });
      expect(retentionViolations("desk-app", { [field]: lease - 1 })).toHaveLength(1);
      expect(retentionViolations("desk-app", { [field]: lease + 1 })).toEqual([]);
    },
  );

  it.each(["pauseRecords", "executionRecords", "auditLog", "a2aTasks"])(
    "%s is no row a fenced write relies on: a short one is fine",
    (field) => {
      expect(retentionViolations("desk-app", { [field]: 1 })).toEqual([]);
    },
  );

  it("a century is the longest; one ms more is a cutoff a date cannot hold", () => {
    const century = hours(24 * 365 * 100);

    expect(retentionViolations("a", { fencedEffects: century })).toEqual([]);
    expect(retentionViolations("a", { fencedEffects: century + 1 })).toEqual([
      expect.objectContaining({
        message: `its retention.fencedEffects is ${String(century + 1)} ms, above a century (${String(century)} ms) — a cutoff a date cannot hold — @Application({ retention: { fencedEffects: hours(24) } })`,
      }),
    ]);
  });

  it("a retention that is no positive finite number is refused, each by what it is", () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "10", null])
      expect(retentionViolations("a", { fencedEffects: value })).toHaveLength(1);
    expect(retentionViolations("a", { fencedEffects: undefined })).toEqual([]);
    expect(retentionViolations("a", undefined)).toEqual([]);
    expect(retentionViolations("a", { fencedEffects: hours(1), auditLog: minutes(30) })).toEqual(
      [],
    );
  });

  it("what is no retention at all names the fix to the fields that matter most", () => {
    const hint =
      "@Application({ retention: { fencedEffects: hours(24), outboundCalls: hours(24) } })";

    expect(retentionViolations("desk-app", { fencedEfects: 5 })).toEqual([
      {
        code: "application.retention-invalid",
        message: `its retention.fencedEfects is not a retention (pauseRecords, executionRecords, auditLog, costLedgerEntries, fencedEffects, outboundCalls, a2aTasks, a2aFiles, a2aMessages) — ${hint}`,
        nodes: ["desk-app"],
      },
    ]);
    expect(retentionViolations("desk-app", 5)[0]?.message).toBe(
      `its retention is 5, not an object of retentions — ${hint}`,
    );
  });

  it("a retention that is no number is refused without asking whether it is finite", () => {
    const finite = vi.spyOn(Number, "isFinite");
    const refused = retentionViolations("a", { fencedEffects: "10" });
    const asked = finite.mock.calls.length;
    finite.mockRestore();

    expect(refused).toHaveLength(1);
    expect(asked).toBe(0);
  });
});
