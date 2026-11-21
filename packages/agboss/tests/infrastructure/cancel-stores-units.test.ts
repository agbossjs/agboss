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
  prunedCallsBefore,
  prunedFencedBefore,
  treeKeyOf,
  type ExecutionLeaseRow,
} from "../../src/infrastructure/in-memory-database.js";
import type { EffectKeyFields } from "../../src/infrastructure/fenced-effect.repository.js";
import {
  checkSqliteCancel,
  markedCancelRequested,
} from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { ensureLeaseSchema } from "../../src/infrastructure/sqlite/sqlite-lease-schema.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const FIELDS: EffectKeyFields = {
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

describe("#1356: the retention of the fenced effects", () => {
  it("prunes the results and the marks stored before the limit, and keeps those stored at it or after", () => {
    const database = new InMemoryDatabase();
    const result = (storedAt: number) => ({ storedAt }) as never;
    database.fencedEffectResults.set("old", result(9));
    database.fencedEffectResults.set("edge", result(10));
    database.fencedEffectMarks.set("old", { highestToken: 1, storedAt: 9 });
    database.fencedEffectMarks.set("edge", { highestToken: 1, storedAt: 10 });

    prunedFencedBefore(database, 10);

    expect([...database.fencedEffectResults.keys()]).toEqual(["edge"]);
    expect([...database.fencedEffectMarks.keys()]).toEqual(["edge"]);
  });
});

describe("#1366: the retention of the in-memory outbound calls", () => {
  const callEnded = (endedAt: number | undefined) => ({ endedAt }) as never;

  it("removes the intents ended before the cut with their place in the order, keeps the one at it, the later and the pending", () => {
    const database = new InMemoryDatabase();
    for (const [row, endedAt] of [
      ["old", 9],
      ["edge", 10],
      ["later", 11],
      ["pending", undefined],
    ] as const) {
      database.outboundCalls.set(row, callEnded(endedAt));
      database.outboundCallOrder.set(row, 1);
    }

    prunedCallsBefore(database, 10);

    expect([...database.outboundCalls.keys()]).toEqual(["edge", "later", "pending"]);
    expect([...database.outboundCallOrder.keys()]).toEqual(["edge", "later", "pending"]);
  });
});

/** A connection to a new file with the lease table made. */
function sqlite() {
  const connection = connectionTo(temporarySqlitePath());
  ensureLeaseSchema(connection);
  return connection;
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
    });
  });

  it("marks the row a lease has, once: a repeat keeps the first time and no other column changes", () => {
    const connection = sqlite();
    connection.database.exec(
      "INSERT INTO execution_leases VALUES ('t1', 'root', 'holder', 4, 99, 0, 1, NULL)",
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
      `INSERT INTO execution_leases VALUES ('t1', 'root', 'h', 1, 1, 0, 0, 0),
         ('t1', 'free', 'h', 1, 1, 0, 0, NULL), ('t2', 'other', 'h', 1, 1, 0, 0, 5)`,
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

describe("#1356: a file whose marks lived in their own table", () => {
  it("has them moved onto the lease rows, a seed row for a tree with none, and its old table dropped", () => {
    const connection = connectionTo(temporarySqlitePath());
    connection.database.exec(`
      CREATE TABLE execution_leases (
        tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
        yielded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, root_execution_id));
      CREATE TABLE execution_cancel_requests (
        tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, requested_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, root_execution_id));
      INSERT INTO execution_leases VALUES ('t1', 'held', 'h', 4, 0, 1, 0);
      INSERT INTO execution_cancel_requests VALUES ('t1', 'held', 11), ('t1', 'bare', 12);`);

    ensureLeaseSchema(connection);
    ensureLeaseSchema(connection);

    expect({ ...rowOf(connection, "held") }).toMatchObject({
      lease_epoch: 4,
      cancel_requested_at: 11,
    });
    expect({ ...rowOf(connection, "bare") }).toMatchObject({
      holder_instance_id: "",
      lease_epoch: 0,
      released: 1,
      cancel_requested_at: 12,
    });
    expect(connection.columnsOf("execution_cancel_requests")).toEqual([]);
  });

  it("adds the columns an older file lacks — yielded (#516) and the mark — to the rows it has", () => {
    const connection = connectionTo(temporarySqlitePath());
    connection.database.exec(`
      CREATE TABLE execution_leases (
        tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, root_execution_id));
      INSERT INTO execution_leases VALUES ('t1', 'old', 'h', 2, 0, 1);`);

    ensureLeaseSchema(connection);

    expect({ ...rowOf(connection, "old") }).toMatchObject({
      yielded: 0,
      cancel_requested_at: null,
    });
  });

  it("makes the table once per connection, by the name it shares with the stores that make it", () => {
    const connection = connectionTo(temporarySqlitePath());
    connection.ensureSchema("execution_leases", "SELECT 1");

    // the name was made already: no second DDL, so no table for the columns to be added to
    expect(() => {
      ensureLeaseSchema(connection);
    }).toThrow();
  });

  it("leaves a file with no old table as it is", () => {
    const connection = sqlite();

    expect(connection.columnsOf("execution_leases")).toContain("cancel_requested_at");
    expect(connection.columnsOf("execution_cancel_requests")).toEqual([]);
  });
});
