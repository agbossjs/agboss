/**
 * #934 AC3: what SQLite kept under 0.1.0 reads back with the new names — a pause's `answeredBy`
 * (the kind) is its `answerer`, the answer's person is `answeredBy`, an answer-log entry's
 * `answeredBy` / `responder` are `answerer` / `answeredBy`, a kept history record's pauses and its
 * children's the same. The rows are inserted as 0.1.0 wrote them: no contract case can, the
 * writer rebuilds the JSON. Nothing is migrated: the rows stay as they were.
 */
import { describe, expect, it } from "vitest";
import { PauseAnswerer, PauseStatus } from "../../../src/index.js";
import {
  exportedRecordLine,
  historyRecordsOf,
} from "../../../src/infrastructure/execution-history-export.js";
import { SqliteExecutionHistoryRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-history.repository.js";
import { SqliteExecutionRecordRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { PAUSES_SCHEMA } from "../../../src/infrastructure/sqlite/sqlite-pause-schema.js";
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { applicationOn, connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { oldAnswerLogEntry, oldHistoryRecord, oldPauseJson } from "./pause-names-0.1.0.fixtures.js";

const clock = new VirtualClock(new Date(0));

describe("AC3: a SQLite file written by 0.1.0", () => {
  it("a Resolved pause's answer keeps its person (answeredBy) and its row says who may answer (answerer)", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(PAUSES_SCHEMA);
    old.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, answer, resolution, resolved_at) VALUES ('default', 'p1', 'run-1:s:1', 'run-1', 'resolved', 1, ?, ?, 'replied', '2026-01-05T09:05:00.000Z')",
      )
      .run(
        oldPauseJson,
        // 0.1.0 PauseAnswer: `answerer` was the person
        JSON.stringify({ decision: { approved: true }, answerer: "manager-17" }),
      );

    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), clock);
    const pause = await pauses.findByTenantIdAndPauseId("default", "p1");

    expect(pause).toMatchObject({
      status: PauseStatus.Resolved,
      answerer: PauseAnswerer.Channel,
      answer: { decision: { approved: true }, answeredBy: "manager-17" },
    });
    expect(pause).not.toHaveProperty("answeredBy");
    expect(pause?.answer).not.toHaveProperty("answerer");
  });

  it("a log entry: answerer = the kind, answeredBy the person", async () => {
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
      .run(JSON.stringify(oldAnswerLogEntry));

    const [entry] = await records.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1");

    expect(entry).toMatchObject({
      answerer: PauseAnswerer.Channel,
      answeredBy: "manager-17",
      responder: "manager-17",
    });
  });

  it("a kept history record and its children's pauses normalised; agboss records export prints the new names", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const history = new SqliteExecutionHistoryRepository(connection);
    connection.database
      .prepare("INSERT INTO execution_history VALUES ('default', 'run-1', 't-1', ?, NULL, ?)")
      .run("2026-01-05T09:00:00.000Z", JSON.stringify(oldHistoryRecord));

    const [record] = await history.findAllByTenantIdAndThreadId("default", "t-1");
    const pauses = [
      record?.pauses[0],
      record?.children[0]?.pauses[0],
      record?.children[0]?.children[0]?.pauses[0],
    ];

    expect(pauses).toMatchObject([
      { answerer: PauseAnswerer.Channel, answeredBy: "manager-17" },
      { answerer: PauseAnswerer.ThreadOwner, answeredBy: "alice" },
      { answerer: PauseAnswerer.Channel, answeredBy: "bob" },
    ]);
    const lines: string[] = [];
    const range = { tenantId: "default", from: new Date(0), to: new Date("2100-01-01") };
    for await (const found of historyRecordsOf(history, range))
      lines.push(exportedRecordLine(found));
    const exported = JSON.parse(lines[0] ?? "{}") as {
      pauses: { answerer: string; answeredBy: string }[];
    };
    expect(exported.pauses[0]).toMatchObject({ answerer: "channel", answeredBy: "manager-17" });
  });
});
