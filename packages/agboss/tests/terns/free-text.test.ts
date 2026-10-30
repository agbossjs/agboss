/**
 * #521 AC4: the SQLite Tern store keeps free text — a task, an answer, a stop reason, a summary —
 * as JSON text, so a NUL character comes back (node:sqlite reads a TEXT value only up to a NUL);
 * migration 14 rewrites the rows of an older database that way, which read back as they were.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteTernStore, openTernDatabase, type NewTern } from "../../src/terns/index.js";
import { NUL_TEXT } from "../../src/testing/contracts/nul-text.js";

const tern = (threadId: string, overrides: Partial<NewTern> = {}): NewTern => ({
  runId: "run-1",
  threadId,
  tenantId: "default",
  bundle: "b",
  task: "task",
  replyWith: "answer",
  status: "answered",
  stopReason: "done",
  route: ["alpha"],
  steps: [{ agent: "alpha", content: "answer" }],
  costUsd: 0.01,
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: null,
  configHash: null,
  ...overrides,
});

/** A database of version 13 (every migration before #521) with one turn and one summary of raw text. */
async function version13(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "terns-")), "v13.sqlite");
  openTernDatabase(path).close();
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA user_version = 13;
    INSERT INTO threads (id, bundle, created_at, tenant_id) VALUES ('t', 'b', '2026-01-01', 'default');
    INSERT INTO terns (id, thread_id, bundle, created_at, task, replyWith, status, stop_reason, route,
      steps, cost_usd, prompt_version, model_version, tenant_id)
    VALUES ('old', 't', 'b', '2026-01-01', 'a "quoted" task', 'line 1
line 2', 'answered', 'done', '[]', '[]', 0, 'p', 'm', 'default');
    INSERT INTO summaries VALUES ('s', 'default', 't', 'b', 'old', 'old', 1, 1, 1, 'first \\ summary',
      0, '2026-01-02', 'conversation-compaction');`);
  old.close();
  return path;
}

describe("#521 AC4: the SQLite Tern store keeps free text as JSON text", () => {
  it("AC4: a task, an answer, a stop reason and a summary with a NUL character read back unchanged", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    const appended = await store.append(
      tern(thread, { task: NUL_TEXT, replyWith: NUL_TEXT, stopReason: NUL_TEXT }),
    );
    await store.addSummary({
      tenantId: "default",
      threadId: thread,
      bundle: "b",
      compaction: "conversation-compaction",
      fromTernId: appended.id,
      toTernId: appended.id,
      turns: 1,
      text: NUL_TEXT,
      costUsd: 0,
    });

    const [read] = await store.byIds([appended.id]);
    const [summary] = await store.latestSummaries("default", thread, "conversation-compaction", 1);

    expect(read).toMatchObject({ task: NUL_TEXT, replyWith: NUL_TEXT, stopReason: NUL_TEXT });
    expect(summary?.text).toBe(NUL_TEXT);
    store.close();
  });

  it("AC4: the column holds the text as JSON — no NUL byte stored", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "terns-")), "nul.sqlite");
    const store = createSqliteTernStore(path, () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    await store.append(tern(thread, { task: "a\u0000b" }));
    store.close();

    const raw = new DatabaseSync(path);
    const row = raw
      .prepare("SELECT task, instr(CAST(task AS BLOB), x'00') AS nul FROM terns")
      .get();
    raw.close();

    expect(row).toEqual({ task: '"a\\u0000b"', nul: 0 });
  });

  it("AC4: migration 14 rewrites an older database's text as JSON — its rows read back as they were", async () => {
    const path = await version13();

    const store = createSqliteTernStore(path, () => new Date());
    const [old] = await store.byIds(["old"]);
    const [summary] = await store.latestSummaries("default", "t", "conversation-compaction", 1);

    expect(old).toMatchObject({
      task: 'a "quoted" task',
      replyWith: "line 1\nline 2",
      stopReason: "done",
    });
    expect(summary?.text).toBe("first \\ summary");
    store.close();
  });
});
