/**
 * 0.1.1 (the pause contract): a pause record stores its `kind` and names its `step`. A SQLite file
 * written before kept neither — `agent`, and a kind told by the component — and is migrated once at
 * open: an approval's row reads `approval`, a question step's `question`, a row from before
 * components (#268 S93) `approval`; its JSON is rewritten, so the reader never infers a kind.
 */
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { PauseKind, PauseStatus } from "../../../src/index.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { PAUSES_SCHEMA } from "../../../src/infrastructure/sqlite/sqlite-pause-schema.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const clock = new VirtualClock(new Date(0));

const APPROVAL_ASK = {
  callId: "call-1",
  tool: "refund",
  arguments: { orderId: "7" },
  summary: "r",
};

/** What a row kept as JSON before 0.1.1: `agent`, no `kind`. */
const storedOf = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    threadId: "thread-1",
    executionId: "run-1",
    workflow: "desk-workflow",
    visitNumber: 1,
    copyNumber: 1,
    askedAt: "2026-01-05T09:00:00.000Z",
    channel: "refund-approval-channel",
    answeredBy: "channel",
    ...fields,
  });

const ROWS = [
  {
    pauseId: "approval-pause",
    pause: storedOf({
      nodeId: "clerk-agent",
      agent: "clerk-agent",
      component: { name: "clerk-agent", kind: "agent" },
      ask: APPROVAL_ASK,
    }),
  },
  {
    pauseId: "question-pause",
    pause: storedOf({
      nodeId: "spending-limit-question",
      agent: "spending-limit-question",
      component: { name: "spending-limit-question", kind: "question" },
      ask: { item: "laptop", priceUsd: 1200 },
    }),
  },
  {
    pauseId: "bare-pause",
    pause: storedOf({ nodeId: "clerk-agent", agent: "clerk-agent", ask: APPROVAL_ASK }),
  },
  {
    // #712: an agent asks a question role through its tool — the role is its component
    pauseId: "tool-question-pause",
    pause: storedOf({
      nodeId: "buyer-agent",
      agent: "buyer-agent",
      component: { name: "approver-question", kind: "question" },
      ask: { item: "laptop" },
    }),
  },
] as const;

const StoredJson = z.object({ pause: z.string() });

/** A read as a promise, whether the store throws or rejects. */
const readOf = (pauses: SqlitePausedExecutionRepository, pauseId: string): Promise<unknown> =>
  Promise.resolve().then(() => pauses.findByTenantIdAndPauseId("default", pauseId));

describe("0.1.1: a SQLite file whose pauses kept no kind", () => {
  it("is migrated at open: each row reads its kind and its step, its JSON rewritten", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(PAUSES_SCHEMA);
    for (const [index, row] of ROWS.entries())
      old.database
        .prepare(
          "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', ?, ?, 'run-1', 'pending', 1, ?)",
        )
        .run(row.pauseId, `run-1:step:${String(index)}`, row.pause);

    const connection = connectionTo(path);
    const pauses = new SqlitePausedExecutionRepository(connection, clock);

    expect(await pauses.findByTenantIdAndPauseId("default", "approval-pause")).toMatchObject({
      kind: PauseKind.Approval,
      step: "clerk-agent",
      ask: APPROVAL_ASK,
      status: PauseStatus.Pending,
    });
    expect(await pauses.findByTenantIdAndPauseId("default", "question-pause")).toMatchObject({
      kind: PauseKind.Question,
      step: "spending-limit-question",
      ask: { item: "laptop", priceUsd: 1200 },
    });
    expect(await pauses.findByTenantIdAndPauseId("default", "bare-pause")).toMatchObject({
      kind: PauseKind.Approval,
      step: "clerk-agent",
    });
    const stored = connection.database
      .prepare("SELECT pause FROM pauses ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(StoredJson.parse(row).pause) as Record<string, unknown>);
    expect(stored.map((json) => [json.kind, json.step, "agent" in json])).toEqual([
      [PauseKind.Approval, "clerk-agent", false],
      [PauseKind.Question, "spending-limit-question", false],
      [PauseKind.Approval, "clerk-agent", false],
      [PauseKind.Question, "buyer-agent", false],
    ]);
    // a second open changes nothing
    const before = connection.database.prepare("SELECT pause FROM pauses ORDER BY rowid").all();
    const again = connectionTo(path);
    new SqlitePausedExecutionRepository(again, clock);
    expect(again.database.prepare("SELECT pause FROM pauses ORDER BY rowid").all()).toEqual(before);
  });

  it("reads a kind as stored: a question whose component is an agent's tool stays a question", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(PAUSES_SCHEMA);
    old.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', 'q', 'run-1:clerk-agent:1:call-1', 'run-1', 'pending', 1, ?)",
      )
      .run(
        storedOf({
          nodeId: "clerk-agent",
          kind: PauseKind.Question,
          step: "clerk-agent",
          component: { name: "spending-limit-tool", kind: "tool" },
          ask: { item: "laptop" },
        }),
      );

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);

    expect(await pauses.findByTenantIdAndPauseId("default", "q")).toMatchObject({
      kind: PauseKind.Question,
      ask: { item: "laptop" },
    });
  });

  it("a row that is not JSON does not stop the file opening; its own read fails, naming it", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(PAUSES_SCHEMA);
    old.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', 'broken', 's', 'run-1', 'pending', 1, '{not json'), ('default', 'old', 's2', 'run-1', 'pending', 1, ?)",
      )
      .run(ROWS[0].pause);

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);

    expect(await pauses.findByTenantIdAndPauseId("default", "old")).toMatchObject({
      kind: PauseKind.Approval,
    });
    await expect(readOf(pauses, "broken")).rejects.toThrow(SyntaxError);
  });

  it("a row the migration could not read (no agent, no kind) fails its read naming the pause", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(PAUSES_SCHEMA);
    old.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', 'kindless', 's', 'run-1', 'pending', 1, ?)",
      )
      .run(storedOf({ nodeId: "clerk-agent", ask: APPROVAL_ASK }));

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);

    await expect(readOf(pauses, "kindless")).rejects.toThrow(
      /pause kindless \(default\) unreadable/,
    );
  });
});
