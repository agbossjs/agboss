/**
 * #934 D1 / D2: a stored value that is neither the 0.1.0 shape nor the new one is refused — in the
 * history record (its pauses and its children's, at any depth), in the answer log and in a pause's
 * answer column alike — with `StoredNamesUnreadableError` naming the record's id and the field, never
 * the value. Rows are inserted as a damaged file would hold them.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SqliteExecutionHistoryRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-history.repository.js";
import { SqliteExecutionRecordRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { PAUSES_SCHEMA } from "../../../src/infrastructure/sqlite/sqlite-pause-schema.js";
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { StoredNamesUnreadableError } from "../../../src/infrastructure/stored-step.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { applicationOn, connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import {
  historyRecordWith,
  leafOf,
  oldAnswer,
  oldHistoryRecord,
  oldPauseJson,
} from "./pause-names-0.1.0.fixtures.js";

const SECRET = "sk-live-PLANTED-SECRET-934";
const clock = new VirtualClock(new Date(0));

/** Everything an error shows: message, stack, the whole cause chain. */
const shown = (error: unknown): string => inspect(error, { depth: 12 });

/** The refusal of `read`: the typed error, its message naming `id` and `field`, no value anywhere. */
async function refusal(read: () => unknown, id: string, field: string): Promise<void> {
  const error = await Promise.resolve()
    .then(read)
    .then(
      () => new Error("it was read"),
      (thrown: unknown) => thrown,
    );
  expect(error).toBeInstanceOf(StoredNamesUnreadableError);
  if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
  expect(error.message).toContain(id);
  expect(error.message).toContain(field);
  expect(shown(error)).not.toContain(SECRET);
  expect(shown(error)).not.toContain("<junk>");
}

/** An entry as a damaged file holds it. */
const entry = (change: Record<string, unknown>): unknown => ({
  ...oldAnswer("run-1", "channel", "manager-17"),
  ...change,
});

/** Entries neither shape accepts, with the field the refusal names. */
const BAD_ENTRIES: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["a 0.1.0 entry with a junk answerer", { answerer: "<junk>" }, "answerer"],
  [
    "a new entry whose answeredBy is an object",
    { answerer: "channel", answeredBy: { t: SECRET } },
    "answeredBy",
  ],
  [
    "a new entry whose answeredBy is a number",
    { answerer: "channel", answeredBy: 42 },
    "answeredBy",
  ],
  ["a 0.1.0 entry whose answeredBy is no kind", { answeredBy: SECRET }, "answeredBy"],
  ["a 0.1.0 entry whose responder is a number", { responder: 42 }, "responder"],
  ["a 0.1.0 entry whose responder is an object", { responder: { t: SECRET } }, "responder"],
];

function historyOn(path: string, record: unknown): SqliteExecutionHistoryRepository {
  const connection = connectionTo(path);
  const history = new SqliteExecutionHistoryRepository(connection);
  connection.database
    .prepare("INSERT INTO execution_history VALUES ('default', 'run-1', 't-1', ?, NULL, ?)")
    .run("2026-01-05T09:00:00.000Z", JSON.stringify(record));
  return history;
}

async function answerLogOn(
  path: string,
  record: unknown,
): Promise<SqliteExecutionRecordRepository> {
  const connection = connectionTo(path);
  const records = new SqliteExecutionRecordRepository(
    connection,
    clock,
    applicationOn(path),
    randomIdGenerator,
  );
  await records.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1");
  connection.database
    .prepare(
      "INSERT INTO pause_answers (tenant_id, root_execution_id, step_key, asked_at, record) VALUES ('default', 'run-1', 'run-1:s:1', '2026-01-05T09:00:00.000Z', ?)",
    )
    .run(JSON.stringify(record));
  return records;
}

describe("D1: the same entry is refused on the history path and on the answer-log path", () => {
  it.each(BAD_ENTRIES)("%s", async (_name, change, field) => {
    const bad = entry(change);
    const history = historyOn(temporarySqlitePath(), { ...oldHistoryRecord, pauses: [bad] });
    const records = await answerLogOn(temporarySqlitePath(), bad);

    await refusal(
      () => history.findByTenantIdAndExecutionId("default", "run-1"),
      "run-1",
      `pauses.0.${field}`,
    );
    await refusal(
      () => records.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1"),
      "run-1",
      field,
    );
  });

  it("an entry a child's child holds is refused at its path", async () => {
    const record = historyRecordWith((tree) => {
      leafOf(tree).pauses = [entry({ answerer: "<junk>" })];
    });
    const history = historyOn(temporarySqlitePath(), record);

    await refusal(
      () => history.findAllByExecutionId("run-1"),
      "run-1",
      "children.0.children.0.pauses.0.answerer",
    );
  });
});

describe("D2: an unreadable history record names its id and the field, nothing else", () => {
  it.each([
    ["a null entry", { pauses: [null] }, "pauses.0"],
    ["an entry that is a text", { pauses: [SECRET] }, "pauses.0"],
    ["pauses missing", { pauses: undefined }, "pauses"],
    ["children that are no list", { children: SECRET }, "children"],
    ["a status that is an object", { status: { t: SECRET } }, "status"],
    ["a startedAt that is a number", { startedAt: 42 }, "startedAt"],
    ["a spend that is a text", { spend: SECRET }, "spend"],
    ["a step that is a number", { steps: [42] }, "steps.0"],
  ])("%s", async (_name, change, field) => {
    const history = historyOn(temporarySqlitePath(), { ...oldHistoryRecord, ...change });

    await refusal(() => history.findByTenantIdAndExecutionId("default", "run-1"), "run-1", field);
  });

  it("a child with a status no one knows is refused at its path", async () => {
    const record = historyRecordWith((tree) => {
      leafOf(tree).status = SECRET;
    });
    const history = historyOn(temporarySqlitePath(), record);

    await refusal(
      () => history.findByTenantIdAndExecutionId("default", "run-1"),
      "run-1",
      "children.0.children.0.status",
    );
  });

  it("an executionId that is no text: the field is named", async () => {
    const history = historyOn(temporarySqlitePath(), {
      ...oldHistoryRecord,
      executionId: { t: SECRET },
    });

    await refusal(
      () => history.findAllByTenantIdAndThreadId("default", "t-1"),
      "threadId t-1",
      "executionId",
    );
  });
});

describe("D1 / D2: a pause's answer column and the answer log", () => {
  const pausesWith = (answer: string): SqlitePausedExecutionRepository => {
    const path = temporarySqlitePath();
    const connection = connectionTo(path);
    connection.database.exec(PAUSES_SCHEMA);
    connection.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, answer, resolution, resolved_at) VALUES ('default', 'p1', 'run-1:s:1', 'run-1', 'resolved', 1, ?, ?, 'replied', '2026-01-05T09:05:00.000Z')",
      )
      .run(oldPauseJson, answer);
    return new SqlitePausedExecutionRepository(connectionTo(path), clock);
  };

  it.each([
    ["an answerer that is an object", { decision: 1, answerer: { t: SECRET } }, "answer.answerer"],
    ["an answeredBy that is a number", { decision: 1, answeredBy: 42 }, "answer.answeredBy"],
    ["a text instead of the answer", SECRET, "answer"],
  ])("a pause whose answer has %s names the pause and the field", async (_name, answer, field) => {
    const pauses = pausesWith(JSON.stringify(answer));

    await refusal(() => pauses.findByTenantIdAndPauseId("default", "p1"), "pauseId p1", field);
  });

  it("an answer-log entry whose role is an object names the execution and the field", async () => {
    const records = await answerLogOn(temporarySqlitePath(), entry({ role: { t: SECRET } }));

    await refusal(
      () => records.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1"),
      "run-1",
      "role",
    );
  });
});
