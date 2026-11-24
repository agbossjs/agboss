import { usd } from "../../../../src/units/index.js";
/**
 * #1366: the SQLite execution-record repository answers every read and score method with the Turn store's rows
 * (cost, status, version, scores, summaries, config snapshots), pings its connection, and is marked a SQLite
 * implementation (a test never reuses it across apps).
 */
import { describe, expect, it } from "vitest";
import { randomIdGenerator } from "../../../../src/infrastructure/clock.js";
import { isSqliteImplementation } from "../../../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteExecutionRecordRepository } from "../../../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { VirtualClock } from "../../../../src/testing/clock.js";
import {
  applicationOn,
  connectionTo,
  temporarySqlitePath,
} from "../../../infrastructure/contracts/store-kinds.js";

function repo() {
  const path = temporarySqlitePath();
  return new SqliteExecutionRecordRepository(
    connectionTo(path),
    new VirtualClock(),
    applicationOn(path),
    randomIdGenerator,
  );
}

const turnOf = (threadId: string, over: Record<string, unknown> = {}) => ({
  runId: null,
  threadId,
  tenantId: "t",
  bundle: "wf",
  task: "do",
  replyWith: "r",
  status: "answered" as const,
  stopReason: "done",
  route: [],
  steps: [],
  costUsd: usd(0.25),
  promptVersion: "v1",
  modelVersion: "m",
  replayOf: null,
  configVersion: null,
  configHash: null,
  ...over,
});

describe("#1366: SqliteExecutionRecordRepository", () => {
  it("is a SQLite implementation and pings", async () => {
    const r = repo();
    expect(isSqliteImplementation(r)).toBe(true);
    await expect(r.ping()).resolves.toBeUndefined();
  });

  it("reads versions, scores, originals, history, summaries and config snapshots from the Turn store", async () => {
    const r = repo();
    const thread = await r.createThread({ workflow: "wf", tenantId: "t" });
    const a = await r.append(turnOf(thread, { costUsd: usd(0.25) }));
    const b = await r.append(turnOf(thread, { costUsd: usd(0.5), promptVersion: "v2" }));
    const c = await r.append(turnOf(thread, { costUsd: usd(1), promptVersion: "v1" }));

    expect((await r.byVersion("wf", "v1", 10)).map((t) => t.id).sort()).toEqual(
      [a.id, c.id].sort(),
    );
    expect((await r.unscored("wf", "v1", 10)).map((t) => t.id).sort()).toEqual([a.id, c.id].sort());
    expect((await r.unscored("wf", undefined, 10)).map((t) => t.id).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    );

    await r.saveScore(a.id, "judge", 0.5);
    await r.saveScore(c.id, "judge", 1);
    expect((await r.unscored("wf", "v1", 10)).map((t) => t.id)).toEqual([]);
    expect(await r.meanScore([a.id, c.id])).toBe(0.75);
    expect(await r.meanScore([b.id])).toBeNull();
    const summary = await r.summary("wf");
    expect(summary).toContainEqual({
      promptVersion: "v1",
      turns: 2,
      scored: 2,
      meanScore: 0.75,
      costUsd: usd(1.25),
    });
    expect(summary).toContainEqual({
      promptVersion: "v2",
      turns: 1,
      scored: 0,
      meanScore: null,
      costUsd: usd(0.5),
    });

    expect((await r.recentOriginals("wf", 10)).map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect((await r.recentOriginals("wf", 2)).map((t) => t.id)).toEqual([b.id, c.id]);

    expect((await r.uncovered("t", thread, "k")).map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect((await r.before("t", thread, c.id, 10)).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(await r.turnNumber("t", thread, c.id)).toBe(3);
    expect(await r.summaryCount("t", thread, "k")).toBe(0);
    await r.addSummary({
      tenantId: "t",
      threadId: thread,
      bundle: "wf",
      compaction: "k",
      fromTurnId: a.id,
      toTurnId: b.id,
      turns: 2,
      text: "s",
      costUsd: usd(0.1),
    });
    expect(await r.summaryCount("t", thread, "k")).toBe(1);
    expect((await r.uncovered("t", thread, "k")).map((t) => t.id)).toEqual([c.id]);

    expect(await r.rememberConfig("wf", "1", "h1", "{}")).toEqual({ drift: false });
    expect(
      (await r.configSnapshots("wf", "1")).map((s) => [s.version, s.hash, s.snapshot]),
    ).toEqual([["1", "h1", "{}"]]);
  });
});
