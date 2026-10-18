import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteTernStore, type NewTern } from "../../src/terns/index.js";

const tern = (overrides: Partial<NewTern> = {}): NewTern => ({
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
  costUsd: 0.01,
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: null,
  configHash: null,
  ...overrides,
});

describe("SQLite Tern store", () => {
  it("#265: a run in flight is no result — summary and byVersion leave out running Terns", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const thread = await store.createThread("b", "default");
    await store.append(tern({ threadId: thread, task: "done", costUsd: 0.01 }));
    await store.append(tern({ threadId: thread, task: "moving", status: "running", costUsd: 0.5 }));

    const originals = await store.byVersion("b", "p1", 10);
    const [summary] = await store.summary("b");

    expect(originals.map((item) => item.task)).toEqual(["done"]);
    expect(summary).toMatchObject({ promptVersion: "p1", terns: 1, costUsd: 0.01 });
  });

  it("#265 S30: pages the Terns with a status, oldest first (recovery's running records)", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const thread = await store.createThread("b", "default");
    for (const task of ["one", "two", "three"])
      await store.append(tern({ threadId: thread, task, status: "running" }));
    await store.append(tern({ threadId: thread, task: "done" }));

    const first = await store.byStatus("running", 2);
    const next = await store.byStatus("running", 2, first.at(-1)?.id);

    expect(first.map((item) => item.task)).toEqual(["one", "two"]);
    expect(next.map((item) => item.task)).toEqual(["three"]);
    expect(await store.byStatus("paused", 2)).toEqual([]);
  });

  it("creates threads per bundle", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const id = await store.createThread("b", "default");

    expect(await store.hasThread("b", "default", id)).toBe(true);
    expect(await store.hasThread("other", "default", id)).toBe(false);
  });

  it("appends Terns and returns the last N of a thread, oldest first", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const thread = await store.createThread("b", "default");
    for (const task of ["one", "two", "three"])
      await store.append(tern({ threadId: thread, task }));

    const last = await store.lastTerns(thread, 2);

    expect(last.map((item) => item.task)).toEqual(["two", "three"]);
    expect(last[0]?.steps).toEqual([{ agent: "alpha", content: "replyWith" }]);
    expect(await store.lastTerns(thread, 0)).toEqual([]);
  });

  it("records every outcome with its status", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const thread = await store.createThread("b", "default");
    const failed = await store.append(tern({ threadId: thread, status: "failed", replyWith: "" }));

    expect((await store.byIds([failed.id]))[0]?.status).toBe("failed");
  });

  it("scores only answered Terns and summarises by prompt version", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const thread = await store.createThread("b", "default");
    const a = await store.append(tern({ threadId: thread }));
    await store.append(tern({ threadId: thread, status: "failed" }));
    await store.append(tern({ threadId: thread, promptVersion: "p2" }));

    expect((await store.unscored("b", "p1", 10)).map((item) => item.id)).toEqual([a.id]);
    expect(await store.unscored("b", undefined, 10)).toHaveLength(2);
    await store.saveScore(a.id, "judge", 0.8);

    expect(await store.meanScore([a.id])).toBe(0.8);
    expect(await store.meanScore([])).toBeNull();
    expect(await store.summary("b")).toEqual([
      { promptVersion: "p1", terns: 2, scored: 1, meanScore: 0.8, costUsd: 0.02 },
      { promptVersion: "p2", terns: 1, scored: 0, meanScore: null, costUsd: 0.01 },
    ]);
  });

  it("lists original Terns of a version, not their replays", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const thread = await store.createThread("b", "default");
    const original = await store.append(tern({ threadId: thread }));
    await store.append(tern({ threadId: thread, replayOf: original.id }));

    expect((await store.byVersion("b", "p1", 10)).map((item) => item.id)).toEqual([original.id]);
  });

  it("opens an existing database without re-running migrations", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "terns-")), "nested", "terns.sqlite");
    const first = createSqliteTernStore(path, () => new Date());
    const thread = await first.createThread("b", "default");
    first.close();

    const second = createSqliteTernStore(path, () => new Date());

    expect(await second.hasThread("b", "default", thread)).toBe(true);
    second.close();
  });

  it("AC9 (#150): migration 5 drops the attempts column — Terns written with it stay readable", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "terns-")), "with-attempts.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const first = createSqliteTernStore(path, () => new Date());
    const thread = await first.createThread("b", "default");
    first.close();
    const old = new DatabaseSync(path);
    // a database of version 4: before migration 8 added `run_id`
    old.exec(`ALTER TABLE terns DROP COLUMN run_id;
      ALTER TABLE terns DROP COLUMN tenant_id;
      ALTER TABLE threads DROP COLUMN tenant_id;
      ALTER TABLE terns ADD COLUMN attempts TEXT NOT NULL DEFAULT '[]';
      INSERT INTO terns (id, thread_id, bundle, created_at, task, replyWith, status, stop_reason, route,
        steps, cost_usd, prompt_version, model_version, replay_of, attempts)
      VALUES ('old', '${thread}', 'b', '2026-01-01', 'q', 'a', 'answered', 'done', '[]', '[]', 0, 'p',
        'm', NULL, '[{"agent":"alpha","attempt":1}]');
      PRAGMA user_version = 4;`);
    old.close();

    const store = createSqliteTernStore(path, () => new Date());
    const fresh = await store.append(tern({ threadId: thread }));

    expect((await store.byIds(["old"]))[0]).toMatchObject({ id: "old", task: "q", replyWith: "a" });
    expect((await store.byIds([fresh.id]))[0]).not.toHaveProperty("attempts");
    store.close();
  });

  it("AC5 (#79), AC6 (#77): migrations 2 and 3 upgrade an old database — existing Terns stay readable", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "terns-")), "old.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, bundle TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE terns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), bundle TEXT NOT NULL,
        created_at TEXT NOT NULL, task TEXT NOT NULL, replyWith TEXT NOT NULL, status TEXT NOT NULL,
        stop_reason TEXT NOT NULL, route TEXT NOT NULL, steps TEXT NOT NULL, cost_usd REAL NOT NULL,
        prompt_version TEXT NOT NULL, model_version TEXT NOT NULL, replay_of TEXT);
      CREATE TABLE scores (tern_id TEXT NOT NULL, judge TEXT NOT NULL, score REAL NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO threads VALUES ('t', 'b', '2026-01-01');
      INSERT INTO terns VALUES ('old', 't', 'b', '2026-01-01', 'q', 'a', 'answered', 'done', '[]', '[]', 0, 'p', 'm', NULL);
      PRAGMA user_version = 1;`);
    old.close();

    const store = createSqliteTernStore(path, () => new Date());
    const fresh = await store.append(tern({ threadId: "t" }));

    expect((await store.byIds(["old"]))[0]).toMatchObject({
      task: "q",
      configVersion: null,
      runId: null,
    });
    expect(await store.summaryCount("t")).toBe(0);
    expect((await store.byIds([fresh.id]))[0]).toMatchObject({ task: "task", runId: "run-1" });
    store.close();
  });
});
