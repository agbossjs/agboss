/**
 * #663 on SQLite — a `ParentInstance` child of before that paused (its refund approved) but sent
 * nothing has no lease and no outbound call; its pause is found by its step key
 * `<executionId>:<node>:<visit>:<callId>`, which names no tree. A new execution minted with that
 * child's id never takes the old approval:
 * - a file of before (no `execution_ids`) keeps the pause's execution and tree: the id is
 *   `DuplicateExecutionIdError`;
 * - a file whose kept ids miss it (filled before #663) runs the new execution, whose step asks
 *   the desk again — a pending pause of its own, nothing refunded.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { DuplicateExecutionIdError } from "../../src/errors.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChildRefundAgent,
  SingleChildWorkflowStart,
} from "../channels/fixtures/child-pauses.workflow.js";
import { refunder } from "../channels/fixtures/pause-scripts.js";
import { resetPauses, seen } from "../channels/fixtures/pauses.workflow.js";
import { minting, resetMinting } from "./fixtures/minted-ids.application.js";
import { sqliteFilePerTest } from "./sqlite/fixtures/sqlite.workflow.js";
import { SqlitePlannedPausesApplication } from "./sqlite/fixtures/sqlite-planned-pauses.application.js";

const file = sqliteFilePerTest();
const test = testWith(SqlitePlannedPausesApplication);

/** The step key the new child's refund call makes: its id, the agent, visit 1, the test's first call. */
const STEP_KEY = "old-child-7:child-refund-agent:1:call-1";

beforeEach(() => {
  resetMinting();
  resetPauses();
});

const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

/** What a pre-#663 row kept as JSON: the child's refund of order A, asked of the finance desk. */
const storedPause = JSON.stringify({
  threadId: "old-thread",
  executionId: "old-child-7",
  workflow: "refund-one-workflow",
  nodeId: "child-refund-agent",
  visitNumber: 1,
  copyNumber: 1,
  askedAt: "2026-01-05T09:00:00.000Z",
  agent: "child-refund-agent",
  channel: "finance-desk-refund-approval-channel",
  answeredBy: "channel",
  ask: { callId: "call-1", tool: "refund-tool", arguments: { orderId: "A" }, summary: "refund A" },
});

/**
 * A file as an older version left it: the old root's lease, and its `ParentInstance` child's
 * refund pause, approved by the desk and taken — no outbound call, and `execution_ids` only when
 * `keptIds` lists it (a file a version between #591 and #663 filled).
 */
function fileWithAnApprovedChildPause(keptIds: readonly string[] | undefined): void {
  const database = new DatabaseSync(file.path);
  try {
    database.exec(`CREATE TABLE execution_leases (
      tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
      yielded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, root_execution_id));
    INSERT INTO execution_leases VALUES ('default', 'old-root', 'instance-0', 1, 0, 1, 0);
    CREATE TABLE pauses (
      tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
      root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
      pause TEXT NOT NULL, answer TEXT, resolution TEXT, resolved_at TEXT,
      PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, step_key));`);
    database
      .prepare(
        "INSERT INTO pauses VALUES ('default', 'old-pause', ?, 'old-root', 'taken', 1, ?, ?, 'replied', ?)",
      )
      .run(
        STEP_KEY,
        storedPause,
        JSON.stringify({ decision: { approved: true }, answerer: "manager-17" }),
        "2026-01-05T09:05:00.000Z",
      );
    if (keptIds === undefined) return;
    database.exec(`CREATE TABLE execution_ids (
      execution_id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL);`);
    for (const id of keptIds)
      database.prepare("INSERT INTO execution_ids VALUES (?, 'default')").run(id);
  } finally {
    database.close();
  }
}

/** The indexes of the file's pauses: each name and whether it is unique, with its columns. */
function pauseIndexesOnFile(): string[] {
  const database = new DatabaseSync(file.path, { readOnly: true });
  try {
    return (
      database.prepare("PRAGMA index_list(pauses)").all() as { name: string; unique: number }[]
    )
      .map(({ name, unique }) => {
        const columns = (
          database.prepare(`PRAGMA index_info("${name}")`).all() as { name: string }[]
        )
          .map((column) => column.name)
          .join(",");
        return `${unique === 1 ? "unique " : ""}${columns}${name.startsWith("sqlite_") ? "" : ` (${name})`}`;
      })
      .sort();
  } finally {
    database.close();
  }
}

/** The pauses on the file: their ids, trees, step keys and statuses, in the order made. */
function pausesOnFile(): unknown[] {
  const database = new DatabaseSync(file.path, { readOnly: true });
  try {
    return database
      .prepare("SELECT pause_id, root_execution_id, step_key, status FROM pauses ORDER BY rowid")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

describe("#663 on SQLite: a ParentInstance child of before that paused", () => {
  test("a file of before keeps its id from its pause: minting it again is DuplicateExecutionIdError, nothing refunded", async ({
    app,
    mockLlm,
  }) => {
    fileWithAnApprovedChildPause(undefined);
    mockLlm(ChildRefundAgent).thenAnswer(refunder(["A"]));
    minting.executions = ["old-child-7"];

    const refused = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "A" }));

    expect(refused).toBeInstanceOf(DuplicateExecutionIdError);
    expect(seen.refunds).toEqual([]);
    expect(seen.asks).toEqual([]);
  });

  test("its tree's root is kept from its pause too, whatever its lease", async ({ app }) => {
    fileWithAnApprovedChildPause(undefined);
    const database = new DatabaseSync(file.path);
    database.exec("DELETE FROM execution_leases");
    database.close();
    minting.executions = ["old-root"];

    const refused = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "A" }));

    expect(refused).toBeInstanceOf(DuplicateExecutionIdError);
  });

  test("an id the kept ids miss: the new child's step asks the desk again — the old approval is never taken", async ({
    app,
    mockLlm,
  }) => {
    fileWithAnApprovedChildPause(["old-root"]);
    mockLlm(ChildRefundAgent).thenAnswer(refunder(["A"]));
    minting.executions = ["new-root", "old-child-7"];

    const result = await execute(app, SingleChildWorkflowStart, { orderId: "A" });

    expect(result.status).toBe(ExecutionStatus.Paused);
    expect(seen.refunds).toEqual([]);
    expect(seen.asks).toHaveLength(1);
    expect(seen.asks[0]?.pauseId).not.toBe("old-pause");
    expect(pausesOnFile()).toEqual([
      { pause_id: "old-pause", root_execution_id: "old-root", step_key: STEP_KEY, status: "taken" },
      {
        pause_id: seen.asks[0]?.pauseId,
        root_execution_id: "new-root",
        step_key: STEP_KEY,
        status: "pending",
      },
    ]);
    expect(pauseIndexesOnFile()).toEqual([
      "status,resolved_at (pauses_by_resolved_at)",
      "tenant_id,root_execution_id (pauses_by_root)",
      "unique tenant_id,pause_id",
      "unique tenant_id,root_execution_id,step_key",
    ]);
  });
});
