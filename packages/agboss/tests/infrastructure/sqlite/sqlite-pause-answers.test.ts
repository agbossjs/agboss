/**
 * #267 S107 on `SqlitePausedExecutionRepository`: a file written before the pause answer records
 * (PR 2: the answer in a `resolution` column, no time it was resolved) is migrated — its pending
 * pause still answered, its taken one read as `Replied`, and both kept by the retention, which
 * counts from `resolved_at` only.
 */
import { describe, expect, it } from "vitest";
import { PauseResolution, PauseStatus } from "../../../src/index.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const clock = new VirtualClock(new Date(0));

/** What a PR 2 row kept as JSON: no copy number, no time it was asked. */
const storedPause = JSON.stringify({
  threadId: "thread-1",
  executionId: "run-1",
  workflow: "desk-workflow",
  nodeId: "clerk-agent",
  visitNumber: 1,
  agent: "clerk-agent",
  channel: "refund-approval-channel",
  answeredBy: "channel",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
});

describe("#267 S107: a SQLite file written before the pause answer records", () => {
  it("is migrated: a taken pause reads as Replied with its answer; a pending one still takes one", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE pauses (
      tenant_id TEXT NOT NULL, pause_id TEXT NOT NULL, step_key TEXT NOT NULL,
      root_execution_id TEXT NOT NULL, status TEXT NOT NULL, is_sent INTEGER NOT NULL,
      pause TEXT NOT NULL, resolution TEXT,
      PRIMARY KEY (tenant_id, pause_id), UNIQUE (tenant_id, step_key));`);
    old.database
      .prepare("INSERT INTO pauses VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "default",
        "taken-pause",
        "run-1:clerk-agent:1:call-1",
        "run-1",
        "taken",
        1,
        storedPause,
        JSON.stringify({ decision: { approved: true }, answerer: "manager-17" }),
      );
    old.database
      .prepare("INSERT INTO pauses VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(
        "default",
        "pending-pause",
        "run-1:clerk-agent:1:call-2",
        "run-1",
        "pending",
        1,
        storedPause,
      );

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);
    await pauses.deleteResolvedBefore(new Date("2100-01-01T00:00:00.000Z"));

    expect(await pauses.findByTenantIdAndPauseId("default", "taken-pause")).toMatchObject({
      status: PauseStatus.Taken,
      resolution: PauseResolution.Replied,
      answer: { decision: { approved: true }, answerer: "manager-17" },
      copyNumber: 1,
    });
    const answer = { decision: { approved: false }, answerer: "manager-18" };
    const resolved = await pauses.resolveByTenantIdAndPauseId(
      "default",
      "pending-pause",
      answer,
      clock.now(),
    );
    expect(resolved).toMatchObject({
      status: PauseStatus.Resolved,
      resolvedAt: "1970-01-01T00:00:00.000Z",
    });
  });
});
