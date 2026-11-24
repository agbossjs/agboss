/**
 * #1356 (cancel-stores shard) — the cancel fence of the in-memory and SQLite stores on its own: which keys a
 * mark of a tree refuses, the seed row of a cancel before the first acquire, the old marks moved onto the lease
 * rows, and the retention of the fenced effects.
 */
import { describe, expect, it } from "vitest";
import { ExecutionCancelFencedError } from "../../src/app/lease-lost.js";
import {
  checkInMemoryCancel,
  InMemoryDatabase,
  laterExpiry,
  prunedCallsAt,
  prunedFencedAt,
  treeKeyOf,
  type ExecutionLeaseRow,
} from "../../src/infrastructure/in-memory-database.js";
import type { EffectKeyFields } from "../../src/infrastructure/fenced-effect.repository.js";
import {
  checkSqliteCancel,
  markedCancelRequested,
} from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const FIELDS: Omit<EffectKeyFields, "expiresAt"> = {
  scopeKey: "scope",
  tenantId: "t1",
  leaseExecutionId: "child",
  rootExecutionId: "root",
  token: 1,
  idempotencyKey: "child:charge:1",
  name: "charge",
};
const key = (changes: Partial<EffectKeyFields> = {}, undo = false) =>
  effectKeyForTesting({ ...FIELDS, ...(undo ? { isCompensation: true as const } : {}) }, changes);

const leaseRow = (cancelRequestedAt?: number): ExecutionLeaseRow =>
  ({
    lease: {},
    released: false,
    ...(cancelRequestedAt === undefined ? {} : { cancelRequestedAt }),
  }) as never;

describe("#1356: the cancel check of the in-memory stores", () => {
  const database = (tenant: string, root: string, at?: number) => {
    const found = new InMemoryDatabase();
    found.executionLeases.set(treeKeyOf(tenant, root), leaseRow(at));
    return found;
  };

  it("refuses a key whose tree's lease row carries the mark — the mark at 0 as well", () => {
    expect(() => {
      checkInMemoryCancel(database("t1", "root", 5), key());
    }).toThrow(ExecutionCancelFencedError);
    expect(() => {
      checkInMemoryCancel(database("t1", "root", 0), key());
    }).toThrow(ExecutionCancelFencedError);
  });

  it("lets a key through when the row has no mark, when there is no row, or when the mark is of another tree or tenant", () => {
    expect(() => {
      checkInMemoryCancel(database("t1", "root"), key());
    }).not.toThrow();
    expect(() => {
      checkInMemoryCancel(new InMemoryDatabase(), key());
    }).not.toThrow();
    expect(() => {
      checkInMemoryCancel(database("t1", "other", 5), key());
    }).not.toThrow();
    expect(() => {
      checkInMemoryCancel(database("t2", "root", 5), key());
    }).not.toThrow();
  });

  it("names the tree by the key's root, or by its own lease execution when it names none", () => {
    const own = key({ rootExecutionId: undefined });
    expect(() => {
      checkInMemoryCancel(database("t1", "child", 5), own);
    }).toThrow(ExecutionCancelFencedError);
    expect(() => {
      checkInMemoryCancel(database("t1", "root", 5), own);
    }).not.toThrow();
  });

  it("never refuses an undo's key", () => {
    expect(() => {
      checkInMemoryCancel(database("t1", "root", 5), key({}, true));
    }).not.toThrow();
  });
});

describe("#1356, #1317: the expiry of the fenced effects", () => {
  it("prunes the results and the marks whose expiry has come, counts them, and keeps those expiring later or never", () => {
    const database = new InMemoryDatabase();
    const result = (expiresAt: number | null) => ({ expiresAt }) as never;
    const mark = (expiresAt: number | null) => ({ highestToken: 1, storedAt: 0, expiresAt });
    database.fencedEffectResults.set("old", result(9));
    database.fencedEffectResults.set("edge", result(10));
    database.fencedEffectResults.set("later", result(11));
    database.fencedEffectResults.set("forever", result(null));
    database.fencedEffectMarks.set("old", mark(9));
    database.fencedEffectMarks.set("edge", mark(10));
    database.fencedEffectMarks.set("later", mark(11));
    database.fencedEffectMarks.set("forever", mark(null));

    expect(prunedFencedAt(database, 10)).toBe(4);

    expect([...database.fencedEffectResults.keys()]).toEqual(["later", "forever"]);
    expect([...database.fencedEffectMarks.keys()]).toEqual(["later", "forever"]);
  });

  it("a scope's mark keeps the latest expiry: never over any date, a later date over an earlier one", () => {
    expect(laterExpiry(undefined, 5)).toBe(5);
    expect(laterExpiry(undefined, null)).toBeNull();
    expect(laterExpiry(null, 5)).toBeNull();
    expect(laterExpiry(5, null)).toBeNull();
    expect(laterExpiry(5, 9)).toBe(9);
    expect(laterExpiry(9, 5)).toBe(9);
  });
});

describe("#1366, #1317: the expiry of the in-memory outbound calls", () => {
  it("removes the intents whose expiry has come with their place in the order and counts them, keeps the later, the never-expiring and the pending", () => {
    const database = new InMemoryDatabase();
    for (const [row, expiresAt] of [
      ["old", 9],
      ["edge", 10],
      ["later", 11],
      ["forever", null],
    ] as const) {
      database.outboundCalls.set(row, {} as never);
      database.outboundCallOrder.set(row, 1);
      database.outboundCallExpiries.set(row, expiresAt);
    }
    // a pending intent has no expiry entry
    database.outboundCalls.set("pending", {} as never);
    database.outboundCallOrder.set("pending", 1);

    expect(prunedCallsAt(database, 10)).toBe(2);

    expect([...database.outboundCalls.keys()]).toEqual(["later", "forever", "pending"]);
    expect([...database.outboundCallOrder.keys()]).toEqual(["later", "forever", "pending"]);
    expect([...database.outboundCallExpiries.keys()]).toEqual(["later", "forever"]);
  });
});

/** A connection to a new file with the lease table made. */
function sqlite() {
  return connectionTo(temporarySqlitePath());
}

const rowOf = (connection: ReturnType<typeof sqlite>, root: string) =>
  connection.database
    .prepare("SELECT * FROM execution_leases WHERE tenant_id = 't1' AND root_execution_id = ?")
    .get(root);

describe("#1356: the cancel mark and check of the SQLite stores", () => {
  it("marks a tree with no row by a seed row: token 0, released, never held, no holder", () => {
    const connection = sqlite();

    markedCancelRequested(connection.database, { tenantId: "t1", rootExecutionId: "root" }, 7);

    expect({ ...rowOf(connection, "root") }).toEqual({
      tenant_id: "t1",
      root_execution_id: "root",
      holder_instance_id: "",
      lease_epoch: 0,
      expires_at: 0,
      released: 1,
      yielded: 0,
      cancel_requested_at: 7,
      stop_requested_at: null,
      stop_mode: null,
      is_externally_paused: 0,
      external_pause_reason: null,
      fenced_through_token: null,
      external_pause_mode: null,
    });
  });

  it("marks the row a lease has, once: a repeat keeps the first time and no other column changes", () => {
    const connection = sqlite();
    connection.database.exec(
      "INSERT INTO execution_leases VALUES ('t1', 'root', 'holder', 4, 99, 0, 1, NULL, NULL, NULL, 0, NULL, NULL, NULL)",
    );
    const tree = { tenantId: "t1", rootExecutionId: "root" };

    markedCancelRequested(connection.database, tree, 7);
    markedCancelRequested(connection.database, tree, 9);

    expect({ ...rowOf(connection, "root") }).toMatchObject({
      holder_instance_id: "holder",
      lease_epoch: 4,
      expires_at: 99,
      released: 0,
      yielded: 1,
      cancel_requested_at: 7,
    });
  });

  it("marks only its own tenant's tree", () => {
    const connection = sqlite();

    markedCancelRequested(connection.database, { tenantId: "t2", rootExecutionId: "root" }, 7);

    expect(rowOf(connection, "root")).toBeUndefined();
  });

  it("refuses the key of a marked tree, the mark at 0 as well, and lets through the rest", () => {
    const connection = sqlite();
    connection.database.exec(
      `INSERT INTO execution_leases VALUES ('t1', 'root', 'h', 1, 1, 0, 0, 0, NULL, NULL, 0, NULL, NULL, NULL),
         ('t1', 'free', 'h', 1, 1, 0, 0, NULL, NULL, NULL, 0, NULL, NULL, NULL), ('t2', 'other', 'h', 1, 1, 0, 0, 5, NULL, NULL, 0, NULL, NULL, NULL)`,
    );
    const database = connection.database;

    expect(() => {
      checkSqliteCancel(database, key());
    }).toThrow(ExecutionCancelFencedError);
    expect(() => {
      checkSqliteCancel(database, key({ rootExecutionId: "free" }));
    }).not.toThrow();
    expect(() => {
      checkSqliteCancel(database, key({ rootExecutionId: "none" }));
    }).not.toThrow();
    expect(() => {
      checkSqliteCancel(database, key({ rootExecutionId: "other" }));
    }).not.toThrow();
    expect(() => {
      checkSqliteCancel(database, key({ rootExecutionId: undefined, leaseExecutionId: "root" }));
    }).toThrow(ExecutionCancelFencedError);
    expect(() => {
      checkSqliteCancel(database, key({}, true));
    }).not.toThrow();
  });
});

describe("#1321c: the lease table of the baseline", () => {
  it("is made when the connection opens, with the yielded column and the cancel mark, and no table of marks of its own", () => {
    const connection = sqlite();

    expect(connection.columnsOf("execution_leases")).toEqual(
      expect.arrayContaining(["yielded", "cancel_requested_at"]),
    );
    expect(connection.columnsOf("execution_cancel_requests")).toEqual([]);
  });
});
