/**
 * #1341c — the pause's fence in the in-memory and SQLite stores on its own: a write of the root lease
 * at the fenced token or below, and a write of a CHILD lease (its own token) while the root's current
 * token is the fenced one, is `ExecutionPauseFencedError`; a lease taken again at token + 1, an
 * `AfterStep` pause and another tree are not fenced. The pause mark carries its mode, which only
 * escalates and starts again after `unpause`.
 */
import { describe, expect, it } from "vitest";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { ExecutionPauseFencedError } from "../../src/app/lease-stopped.js";
import type { EffectKeyFields } from "../../src/infrastructure/fenced-effect.repository.js";
import {
  checkInMemoryCancel,
  InMemoryDatabase,
  treeKeyOf,
  type ExecutionLeaseRow,
} from "../../src/infrastructure/in-memory-database.js";
import { pausedInMemory, unpausedInMemory } from "../../src/infrastructure/in-memory-pause-mark.js";
import {
  markedPaused,
  pauseMarksOf,
  liftedPause,
} from "../../src/infrastructure/sqlite/sqlite-pause.js";
import { checkSqliteCancel } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const TREE = { tenantId: "t1", rootExecutionId: "root" };
const FIELDS: Omit<EffectKeyFields, "expiresAt"> = {
  scopeKey: "scope",
  tenantId: "t1",
  leaseExecutionId: "root",
  rootExecutionId: "root",
  token: 5,
  idempotencyKey: "root:charge:1",
  name: "charge",
};
const rootKey = (token: number) => effectKeyForTesting({ ...FIELDS }, { token });
const childKey = (token: number) =>
  effectKeyForTesting({ ...FIELDS }, { leaseExecutionId: "child-1", token });

const rootRow = (token: number): ExecutionLeaseRow =>
  ({ lease: { token }, released: false }) as never;

interface Store {
  pause(mode: InterruptMode, reason?: string): void;
  unpause(): void;
  setRootToken(token: number): void;
  check(key: ReturnType<typeof rootKey>): void;
  mode(): InterruptMode | undefined;
}

function inMemory(): Store {
  const database = new InMemoryDatabase();
  database.executionLeases.set(treeKeyOf("t1", "root"), rootRow(5));
  return {
    pause: (mode, reason) =>
      void pausedInMemory(database, TREE, { request: { mode, reason }, now: 0 }),
    unpause: () => void unpausedInMemory(database, TREE, { now: 0 }),
    setRootToken: (token) => {
      const current = database.executionLeases.get(treeKeyOf("t1", "root"));
      if (current === undefined) throw new Error("the root's row is seeded");
      database.executionLeases.set(treeKeyOf("t1", "root"), {
        ...current,
        lease: { token } as never,
      });
    },
    check: (key) => {
      checkInMemoryCancel(database, key);
    },
    mode: () => database.executionLeases.get(treeKeyOf("t1", "root"))?.externalPause?.mode,
  };
}

function sqlite(): Store {
  const connection = connectionTo(temporarySqlitePath());
  const { database } = connection;
  database.exec(
    "INSERT INTO execution_leases (tenant_id, root_execution_id, holder_instance_id, lease_epoch, expires_at, released, yielded) VALUES ('t1', 'root', 'h', 5, 99, 0, 0)",
  );
  return {
    pause: (mode, reason) => {
      markedPaused(database, TREE, { request: { mode, reason }, now: 0 });
    },
    unpause: () => {
      liftedPause(database, TREE, { now: 0 });
    },
    setRootToken: (token) => {
      database.prepare("UPDATE execution_leases SET lease_epoch = ?").run(token);
    },
    check: (key) => {
      checkSqliteCancel(database, key);
    },
    mode: () => pauseMarksOf(database, TREE).pause?.mode,
  };
}

describe.each([
  ["in-memory", inMemory],
  ["SQLite", sqlite],
])("#1341c: the pause fence of the %s stores", (_name, make) => {
  it("an Immediate pause refuses the root lease's token and below, and every child's write while the root's token is the fenced one", () => {
    const store = make();
    store.pause(InterruptMode.Immediate);

    for (const key of [rootKey(5), rootKey(4), childKey(1), childKey(99)])
      expect(() => {
        store.check(key);
      }).toThrow(ExecutionPauseFencedError);
    expect(() => {
      store.check(rootKey(6));
    }).not.toThrow();
  });

  it("the lease taken again at token + 1 is not fenced — the root's and its children's — and the fence outlives unpause", () => {
    const store = make();
    store.pause(InterruptMode.Immediate);
    store.unpause();
    // the fence outlives the lift: the stale token is refused until the lease is taken again
    expect(() => {
      store.check(rootKey(5));
    }).toThrow(ExecutionPauseFencedError);

    store.setRootToken(6);

    expect(() => {
      store.check(rootKey(6));
    }).not.toThrow();
    expect(() => {
      store.check(childKey(1));
    }).not.toThrow();
    expect(() => {
      store.check(rootKey(5));
    }).toThrow(ExecutionPauseFencedError);
  });

  it("an AfterStep pause fences nothing, root or child", () => {
    const store = make();
    store.pause(InterruptMode.AfterStep);

    expect(() => {
      store.check(rootKey(5));
    }).not.toThrow();
    expect(() => {
      store.check(childKey(1));
    }).not.toThrow();
  });

  it("the mode of the mark only escalates while the pause lasts and starts again after unpause", () => {
    const store = make();
    store.pause(InterruptMode.AfterStep);
    expect(store.mode()).toBe(InterruptMode.AfterStep);
    store.pause(InterruptMode.Immediate);
    store.pause(InterruptMode.AfterStep, "again");
    expect(store.mode()).toBe(InterruptMode.Immediate);

    store.unpause();
    expect(store.mode()).toBeUndefined();
    store.pause(InterruptMode.AfterStep);
    expect(store.mode()).toBe(InterruptMode.AfterStep);
  });
});
