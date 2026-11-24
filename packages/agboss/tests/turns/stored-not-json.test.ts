import { usd } from "../../src/units/index.js";
/**
 * #1194 (#1166, #1121, #906 D4-b): the SQLite Turn store reads its stored texts — a turn's task,
 * answer, stop reason, route and steps, a summary's text — with `parsedStoredJson`: a row whose text
 * is no JSON is the coded `StoredNamesUnreadableError` (`code: "stored.unreadable"`, the record, the
 * row's ids) and quotes no stored text, not in the message, the stack or the cause. A column that
 * goes back to a bare `JSON.parse` fails its cases: the parser's `SyntaxError` quotes the planted
 * secret and has no code.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StoredNamesUnreadableError } from "../../src/infrastructure/stored-step.js";
import { createSqliteTurnStore } from "../../src/turns/index.js";

const SECRET = "ssn-078-05-1194";
/** Texts that are no JSON: the parser quotes the text around where it failed. */
const TEXTS: readonly (readonly [string, string])[] = [
  ["a bare secret", SECRET],
  ["a text that breaks at the secret", `{"startInput":{"name":${SECRET}}}`],
  ["a text that breaks after the secret", `["${SECRET}",undefined]`],
];

/** A column of a turn row and the record the refusal names. */
const TURN_COLUMNS: readonly (readonly [string, string])[] = [
  ["task", "turn task"],
  ["replyWith", "turn answer"],
  ["stop_reason", "turn stop reason"],
  ["route", "turn route"],
  ["steps", "turn steps"],
];

/** A store on a file with one turn and one summary, and the file's path. */
async function seeded(): Promise<{ path: string; turnId: string; threadId: string }> {
  const path = join(await mkdtemp(join(tmpdir(), "terns-1194-")), "turns.sqlite");
  const store = createSqliteTurnStore(path, () => new Date());
  const threadId = await store.createThread({ workflow: "b", tenantId: "default" });
  const turn = await store.append({
    runId: "run-1194",
    threadId,
    tenantId: "default",
    bundle: "b",
    task: "task",
    replyWith: "answer",
    status: "answered",
    stopReason: "done",
    route: ["alpha"],
    steps: [{ agent: "alpha", content: "answer" }],
    costUsd: usd(0),
    promptVersion: "p",
    modelVersion: "m",
    replayOf: null,
    configVersion: null,
    configHash: null,
  });
  await store.addSummary({
    tenantId: "default",
    threadId,
    bundle: "b",
    compaction: "c",
    fromTurnId: turn.id,
    toTurnId: turn.id,
    turns: 1,
    text: "summary",
    costUsd: usd(0),
  });
  store.close();
  return { path, turnId: turn.id, threadId };
}

/** The error `read` throws or rejects with (a store method may throw before it returns a promise). */
async function rejection(read: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve()
    .then(read)
    .then(
      () => new Error("it was read"),
      (thrown: unknown) => thrown,
    );
}

/** What an unreadable refusal must be: coded, named, and without any stored text. */
function expectRefusal(error: unknown, record: string, ids: string): void {
  expect(error).toBeInstanceOf(StoredNamesUnreadableError);
  expect(error).toMatchObject({ code: "stored.unreadable", record, ids });
  expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  const shown = inspect(error, { depth: 10 });
  expect(shown).not.toContain(SECRET);
  expect(shown).not.toContain("startInput");
  expect(shown).not.toContain("Unexpected");
  expect(shown).not.toContain("JSON.parse");
}

describe("#1194: a stored turn text that is no JSON is unreadable, not a SyntaxError with the text", () => {
  describe.each(TURN_COLUMNS)("the turn's %s column", (column, record) => {
    it.each(TEXTS)("%s", async (_name, text) => {
      const { path, turnId } = await seeded();
      const raw = new DatabaseSync(path);
      raw.prepare(`UPDATE terns SET ${column} = ? WHERE id = ?`).run(text, turnId);
      raw.close();
      const store = createSqliteTurnStore(path, () => new Date());

      const error = await rejection(() => store.byIds([turnId]));
      store.close();

      expectRefusal(error, record, `turnId ${turnId}, runId run-1194`);
    });
  });

  describe("a summary's text", () => {
    it.each(TEXTS)("%s", async (_name, text) => {
      const { path, threadId } = await seeded();
      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE summaries SET text = ?").run(text);
      raw.close();
      const store = createSqliteTurnStore(path, () => new Date());

      const error = await rejection(() => store.latestSummaries("default", threadId, "c", 1));
      store.close();

      expect(error).toBeInstanceOf(StoredNamesUnreadableError);
      expect(error).toMatchObject({ code: "stored.unreadable", record: "turn summary text" });
      expect(inspect(error, { depth: 10 })).not.toContain(SECRET);
    });
  });

  it("a text that is JSON of the wrong shape is still a schema failure, and the readable row reads", async () => {
    const { path, turnId } = await seeded();
    const store = createSqliteTurnStore(path, () => new Date());
    const [read] = await store.byIds([turnId]);
    store.close();
    expect(read).toMatchObject({ task: "task", route: ["alpha"] });
  });
});
