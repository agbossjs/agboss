/**
 * 0.1.1 (the pause contract): a pause record stores its `kind` and names its `step`; the reader never
 * infers a kind — a row without one fails its own read, naming the pause.
 */
import { pauseKeyOf } from "../../../src/infrastructure/pause-record.js";
import { StoreError } from "../../../src/core/error-families/store-errors.js";
import { describe, expect, it } from "vitest";
import { PauseKind } from "../../../src/index.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { PAUSES_SCHEMA } from "../../../src/infrastructure/sqlite/sqlite-pause-schema.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const clock = new VirtualClock(new Date(0));

const APPROVAL = {
  input: { orderId: "7" },
  toolCall: { callId: "call-1", tool: "refund", summary: "r" },
};

/** A row's pause as JSON, in the 0.1.1 shape. */
const storedOf = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    threadId: "thread-1",
    executionId: "run-1",
    workflow: "desk-workflow",
    visitNumber: 1,
    copyNumber: 1,
    askedAt: "2026-01-05T09:00:00.000Z",
    target: "refund-tool-approval",
    channel: "refund-approval-channel",
    respondent: "delegate",
    trail: [
      {
        action: "opened",
        at: "2026-01-05T09:00:00.000Z",
        target: "refund-approval-channel",
      },
    ],
    ...fields,
  });

/** A read as a promise, whether the store throws or rejects. */
const readOf = (pauses: SqlitePausedExecutionRepository, pauseId: string): Promise<unknown> =>
  Promise.resolve().then(() => pauses.findByTenantIdAndPauseId("default", pauseId));

describe("0.1.1: the SQLite pause store reads the kind it stores", () => {
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
          kind: PauseKind.ExternalTask,
          step: "clerk-agent",
          component: { name: "spending-limit-tool", kind: "tool" },
          input: { item: "laptop" },
        }),
      );

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);

    expect(await pauses.findByTenantIdAndPauseId("default", "q")).toMatchObject({
      kind: PauseKind.ExternalTask,
      input: { item: "laptop" },
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
      .run(
        storedOf({
          nodeId: "clerk-agent",
          kind: PauseKind.Approval,
          step: "clerk-agent",
          ...APPROVAL,
        }),
      );

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);

    expect(await pauses.findByTenantIdAndPauseId("default", "old")).toMatchObject({
      kind: PauseKind.Approval,
    });
    await expect(readOf(pauses, "broken")).rejects.toThrow(StoreError.UnreadableRecord);
  });

  it("a row the migration could not read (no agent, no kind) fails its read naming the pause", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(PAUSES_SCHEMA);
    old.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', 'kindless', 's', 'run-1', 'pending', 1, ?)",
      )
      .run(storedOf({ nodeId: "clerk-agent", ...APPROVAL }));

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);

    await expect(readOf(pauses, "kindless")).rejects.toThrow(
      new RegExp(
        `a stored pause is not readable \\(pause ${pauseKeyOf("default", "kindless")}, executionId run-1.*kind`,
      ),
    );
  });
});
