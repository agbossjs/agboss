/**
 * #1121 (#906 D4 remnant): a stored record whose text is not JSON is refused as a stored record that
 * fails its schema is — `StoredNamesUnreadableError`, `code: "stored.unreadable"`, the record and the
 * row's ids — and, as D4-b has it, quotes no stored text: not in the message, not in the stack, not in
 * the cause (a parser's own message quotes the text it failed on).
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { decodePausedRun } from "../../../src/app/paused-runs.js";
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { SqliteExecutionHistoryRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-history.repository.js";
import { SqliteExecutionRecordRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { PAUSES_SCHEMA } from "../../../src/infrastructure/sqlite/sqlite-pause-schema.js";
import {
  parsedStoredJson,
  pauseAnswerRecordOfJson,
  StoredNamesUnreadableError,
} from "../../../src/infrastructure/stored-step.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { applicationOn, connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { pauseJson } from "./stored-rows.fixtures.js";

const SECRET = "ssn-078-05-1120";
/**
 * Texts that are no JSON. A parser quotes the text around where it failed: the bare secret and the
 * one that breaks at the secret are quoted whole, the first only as its tail.
 */
const TEXTS: readonly (readonly [string, string])[] = [
  ["a text that breaks after the secret", `{"startInput":{"name":"${SECRET}"},"x":undefined}`],
  ["a bare secret", SECRET],
  ["a text that breaks at the secret", `{"startInput":{"name":${SECRET}}}`],
];
const clock = new VirtualClock(new Date(0));

/** The error `read` throws (a promise rejects as it throws). */
async function thrownBy(read: () => unknown): Promise<unknown> {
  return Promise.resolve()
    .then(read)
    .then(
      () => new Error("it was read"),
      (thrown: unknown) => thrown,
    );
}

/** The refusal: the coded class, its record and ids, the parse error as its cause, no text anywhere. */
async function refused(read: () => unknown, record: string, ids: string): Promise<void> {
  const error = await thrownBy(read);
  expect(error).toBeInstanceOf(StoredNamesUnreadableError);
  if (!(error instanceof StoredNamesUnreadableError)) throw new TypeError("not the coded error");
  expect(error.code).toBe("stored.unreadable");
  expect(error.record).toBe(record);
  expect(error.ids).toBe(ids);
  expect(error.message).toContain("not valid JSON");
  expect(error.cause).toBeInstanceOf(SyntaxError);
  expect(inspect(error, { depth: 12 })).not.toContain(SECRET);
  expect(inspect(error, { depth: 12 })).not.toContain("startInput");
  expect(inspect(error, { depth: 12 })).not.toMatch(/Unexpected|JSON\.parse/);
}

describe.each(TEXTS)("#1121: %s is the coded unreadable refusal", (_name, NOT_JSON) => {
  it("a paused run (the helper SQLite reads it with)", async () => {
    await refused(
      () => decodePausedRun(NOT_JSON, { threadId: "t1", runId: "r1" }),
      "paused run",
      "threadId t1, runId r1",
    );
  });

  it("a pause answer", async () => {
    await refused(() => pauseAnswerRecordOfJson(NOT_JSON), "pause answer", "");
  });

  it("the helper stores share: the ids it is given, the record it names", async () => {
    await refused(
      () =>
        parsedStoredJson({
          what: "pause",
          text: NOT_JSON,
          ids: { pauseId: "p1", tenantId: undefined },
        }),
      "pause",
      "pauseId p1",
    );
  });

  it("a text that is JSON is parsed, its reviver applied", () => {
    expect(
      parsedStoredJson({
        what: "pause",
        text: '{"a":1}',
        reviver: (_key, value) => (value === 1 ? 2 : value),
      }),
    ).toEqual({ a: 2 });
  });

  it("a history row", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const history = new SqliteExecutionHistoryRepository(connection);
    connection.database
      .prepare("INSERT INTO execution_history VALUES ('default', 'run-1', 't-1', ?, NULL, ?)")
      .run("2026-01-05T09:00:00.000Z", NOT_JSON);

    await refused(
      () => history.findByTenantIdAndExecutionId("default", "run-1"),
      "execution history record",
      "executionId run-1",
    );
  });

  it("a pause row: its pause column, and its answer column", async () => {
    const path = temporarySqlitePath();
    const connection = connectionTo(path);
    connection.database.exec(PAUSES_SCHEMA);
    const insert = connection.database.prepare(
      "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, answer, resolution, resolved_at) VALUES ('default', ?, ?, 'run-1', 'resolved', 1, ?, ?, 'replied', '2026-01-05T09:05:00.000Z')",
    );
    insert.run("p1", "run-1:s:1", NOT_JSON, null);
    insert.run("p2", "run-1:s:2", pauseJson, NOT_JSON);
    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);

    await refused(() => pauses.findByTenantIdAndPauseId("default", "p1"), "pause", "pauseId p1");
    await refused(
      () => pauses.findByTenantIdAndPauseId("default", "p2"),
      "pause answer",
      "pauseId p2",
    );
  });

  it("an answer-log row", async () => {
    const path = temporarySqlitePath();
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
      .run(NOT_JSON);

    await refused(
      () => records.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1"),
      "pause answer",
      "",
    );
  });
});
