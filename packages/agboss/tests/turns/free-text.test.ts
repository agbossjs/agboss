/**
 * #521 AC4: the SQLite Turn store keeps free text — a task, an answer, a stop reason, a summary —
 * as JSON text, so a NUL character comes back (node:sqlite reads a TEXT value only up to a NUL).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteTurnStore, type NewTurn } from "../../src/turns/index.js";
import { NUL_TEXT } from "../../src/testing/contracts/nul-text.js";

const turn = (threadId: string, overrides: Partial<NewTurn> = {}): NewTurn => ({
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

describe("#521 AC4: the SQLite Turn store keeps free text as JSON text", () => {
  it("AC4: a task, an answer, a stop reason and a summary with a NUL character read back unchanged", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    const appended = await store.append(
      turn(thread, { task: NUL_TEXT, replyWith: NUL_TEXT, stopReason: NUL_TEXT }),
    );
    await store.addSummary({
      tenantId: "default",
      threadId: thread,
      bundle: "b",
      compaction: "conversation-compaction",
      fromTurnId: appended.id,
      toTurnId: appended.id,
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
    const store = createSqliteTurnStore(path, () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    await store.append(turn(thread, { task: "a\u0000b" }));
    store.close();

    const raw = new DatabaseSync(path);
    const row = raw
      .prepare("SELECT task, instr(CAST(task AS BLOB), x'00') AS nul FROM terns")
      .get();
    raw.close();

    expect(row).toEqual({ task: '"a\\u0000b"', nul: 0 });
  });
});
