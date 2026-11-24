import { usd } from "../../src/units/index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteTurnStore, type NewTurn } from "../../src/turns/index.js";

const turn = (overrides: Partial<NewTurn> = {}): NewTurn => ({
  runId: "run-1",
  threadId: "t",
  tenantId: "default",
  bundle: "b",
  task: "task",
  replyWith: "replyWith",
  status: "answered",
  stopReason: "done",
  route: ["alpha"],
  steps: [{ agent: "alpha", content: "replyWith" }],
  costUsd: usd(0.01),
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: null,
  configHash: null,
  ...overrides,
});

describe("SQLite Turn store", () => {
  it("#265: a run in flight is no result — summary and byVersion leave out running Terns", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    await store.append(turn({ threadId: thread, task: "done", costUsd: usd(0.01) }));
    await store.append(
      turn({ threadId: thread, task: "moving", status: "running", costUsd: usd(0.5) }),
    );

    const originals = await store.byVersion("b", "p1", 10);
    const [summary] = await store.summary("b");

    expect(originals.map((item) => item.task)).toEqual(["done"]);
    expect(summary).toMatchObject({ promptVersion: "p1", turns: 1, costUsd: usd(0.01) });
  });

  it("#265 S30: pages the Terns with a status, oldest first (recovery's running records)", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    for (const task of ["one", "two", "three"])
      await store.append(turn({ threadId: thread, task, status: "running" }));
    await store.append(turn({ threadId: thread, task: "done" }));

    const first = await store.byStatus("running", 2);
    const next = await store.byStatus("running", 2, first.at(-1)?.id);

    expect(first.map((item) => item.task)).toEqual(["one", "two"]);
    expect(next.map((item) => item.task)).toEqual(["three"]);
    expect(await store.byStatus("paused", 2)).toEqual([]);
  });

  it("creates threads per bundle", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const id = await store.createThread({ workflow: "b", tenantId: "default" });

    expect(await store.hasThread("b", "default", id)).toBe(true);
    expect(await store.hasThread("other", "default", id)).toBe(false);
  });

  it("appends Terns and returns the last N of a thread, oldest first", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    for (const task of ["one", "two", "three"])
      await store.append(turn({ threadId: thread, task }));

    const last = await store.lastTurns("default", thread, 2);

    expect(last.map((item) => item.task)).toEqual(["two", "three"]);
    expect(last[0]?.steps).toEqual([{ agent: "alpha", content: "replyWith" }]);
    expect(await store.lastTurns("default", thread, 0)).toEqual([]);
  });

  it("records every outcome with its status", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    const failed = await store.append(turn({ threadId: thread, status: "failed", replyWith: "" }));

    expect((await store.byIds([failed.id]))[0]?.status).toBe("failed");
  });

  it("scores only answered Terns and summarises by prompt version", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    const a = await store.append(turn({ threadId: thread }));
    await store.append(turn({ threadId: thread, status: "failed" }));
    await store.append(turn({ threadId: thread, promptVersion: "p2" }));

    expect((await store.unscored("b", "p1", 10)).map((item) => item.id)).toEqual([a.id]);
    expect(await store.unscored("b", undefined, 10)).toHaveLength(2);
    await store.saveScore(a.id, "judge", 0.8);

    expect(await store.meanScore([a.id])).toBe(0.8);
    expect(await store.meanScore([])).toBeNull();
    expect(await store.summary("b")).toEqual([
      { promptVersion: "p1", turns: 2, scored: 1, meanScore: 0.8, costUsd: usd(0.02) },
      { promptVersion: "p2", turns: 1, scored: 0, meanScore: null, costUsd: usd(0.01) },
    ]);
  });

  it("lists original Terns of a version, not their replays", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    const original = await store.append(turn({ threadId: thread }));
    await store.append(turn({ threadId: thread, replayOf: original.id }));

    expect((await store.byVersion("b", "p1", 10)).map((item) => item.id)).toEqual([original.id]);
  });

  it("opens an existing database without re-running migrations", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "terns-")), "nested", "terns.sqlite");
    const first = createSqliteTurnStore(path, () => new Date());
    const thread = await first.createThread({ workflow: "b", tenantId: "default" });
    first.close();

    const second = createSqliteTurnStore(path, () => new Date());

    expect(await second.hasThread("b", "default", thread)).toBe(true);
    second.close();
  });

  it("#262 Q4: one id in two tenants is two threads — owners, turns and summaries apart", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const acme = { workflow: "b", tenantId: "acme", threadId: "order-7" };
    const globex = { workflow: "b", tenantId: "globex", threadId: "order-7" };

    expect(await store.createThread({ ...acme, ownerId: "alice" })).toBe("order-7");
    await store.createThread({ ...globex, ownerId: "bob" });
    await store.createThread({ ...acme, ownerId: "mallory" }); // exists: kept as it is
    const first = await store.append(
      turn({ tenantId: "acme", threadId: "order-7", task: "acme 1" }),
    );
    await store.append(turn({ tenantId: "globex", threadId: "order-7", task: "globex 1" }));
    await store.addSummary({
      tenantId: "acme",
      threadId: "order-7",
      bundle: "b",
      compaction: "conversation-compaction",
      fromTurnId: first.id,
      toTurnId: first.id,
      turns: 1,
      text: "acme so far",
      costUsd: usd(0),
    });

    expect(await store.threadOwner("b", "acme", "order-7")).toEqual({ owner: "alice" });
    expect(await store.threadOwner("b", "globex", "order-7")).toEqual({ owner: "bob" });
    expect(await store.hasThread("b", "initech", "order-7")).toBe(false);
    const turns = await store.lastTurns("globex", "order-7", 10);
    expect(turns.map((item) => [item.task, item.tenantId, item.threadId])).toEqual([
      ["globex 1", "globex", "order-7"],
    ]);
    const compaction = "conversation-compaction";
    expect(await store.summaryCount("acme", "order-7", compaction)).toBe(1);
    expect(await store.summaryCount("globex", "order-7", compaction)).toBe(0);
    expect(await store.uncovered("acme", "order-7", compaction)).toEqual([]);
    expect(
      (await store.uncovered("globex", "order-7", compaction)).map((item) => item.task),
    ).toEqual(["globex 1"]);
    expect(
      (await store.latestSummaries("acme", "order-7", compaction, 5)).map((item) => item.tenantId),
    ).toEqual(["acme"]);
    // #120 PR 3: each compaction keeps its own summaries of the thread
    expect(await store.summaryCount("acme", "order-7", "code-context-compaction")).toBe(0);
    expect((await store.uncovered("acme", "order-7", "code-context-compaction")).length).toBe(1);
    store.close();
  });

  it("#267 S107: the pause answer log keeps one entry per pause, a tree's in the order asked", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const entry = { tenantId: "acme", rootExecutionId: "root-1" };
    await store.appendPauseAnswer({
      ...entry,
      stepKey: "b",
      askedAt: "2026-01-05T09:02",
      record: "b",
    });
    await store.appendPauseAnswer({
      ...entry,
      stepKey: "a",
      askedAt: "2026-01-05T09:01",
      record: "a",
    });
    await store.appendPauseAnswer({
      ...entry,
      stepKey: "a",
      askedAt: "2026-01-05T09:01",
      record: "again",
    });
    await store.appendPauseAnswer({
      ...entry,
      stepKey: "c",
      askedAt: "2026-01-05T09:01",
      record: "c",
    });
    await store.appendPauseAnswer({
      ...entry,
      tenantId: "other",
      stepKey: "d",
      askedAt: "",
      record: "d",
    });

    expect(await store.pauseAnswersOf("acme", "root-1")).toEqual(["a", "c", "b"]);
    expect(await store.pauseAnswersOf("acme", "root-2")).toEqual([]);
    store.close();
  });
});
