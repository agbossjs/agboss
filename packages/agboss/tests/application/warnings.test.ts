/**
 * #261 AC14 — assembly warnings: tenant or application budgets on the built-in in-memory cost ledger,
 * and pauses possible with the built-in in-memory paused executions or checkpoints; #120 S94 — PII
 * tokens on a key of the instance (no `pseudonymKey`). In `app.warnings` and the start log; errors
 * under `agboss check --strict` (the CLI's tests); silent in tests (`testWith`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildApplication, createApp } from "../../src/application/create-app.js";
import { TEST_PSEUDONYM_KEY } from "../../src/pii/application-key.js";
import { applicationOf } from "../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
import { applicationWarningsOf } from "../../src/describe/application.js";
import { KeyedApplication } from "../pii/fixtures/keyed/keyed.application.js";
import { ClinicApplication } from "../guardrails/guardrails.fixture.js";
import { LogLevel } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { logged, resetLogged } from "../helpers/log.js";
import { HistoryDeskApplication } from "../flow/fixtures/execution-history.fixture.js";
import { SqliteExecutionHistoryRepository } from "../../src/infrastructure/sqlite/sqlite-execution-history.repository.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { QuestionsApplication } from "../flow/fixtures/questions.fixture.js";
import { OrderApplication } from "../testing/fixtures/order.application.js";
import {
  DurableLoggedApplication,
  LoggedApplication,
  NoteLoggedApplication,
} from "./fixtures/logged.application.js";

const LEDGER =
  "[application.in-memory-cost-ledger] in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart";
const PAUSES =
  "[application.in-memory-pauses] in-memory pauses: the pause records (PausedExecutionRepository — list SqlitePausedExecutionRepository) and the checkpoints (BaseCheckpointSaver — list SqliteCheckpointSaver) are kept in memory — another application instance cannot resume a pause and it is lost on restart";
const PII_KEY =
  "[application.pii-instance-key] no @Application({ pseudonymKey }): sensitive fields make PII tokens with a key of each execution — one value gets another token in each execution (in logs and traces: on each instance), so tokens compare across executions only with pseudonymKey";

const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };

beforeEach(resetLogged);

describe("#261 AC14: in-memory ledger and pauses warn", () => {
  it("the built-in in-memory ledger with tenant and application budgets, and pauses in memory: both", async () => {
    const app = await createApp(LoggedApplication, offline);
    await app.close();

    // its text start's `sender` is sensitive (a token): the instance key's warning too (#644)
    expect(app.warnings).toEqual([LEDGER, PAUSES, PII_KEY]);
    expect(
      logged.filter((entry) => entry.level === LogLevel.Warn).map((entry) => entry.message),
    ).toEqual([LEDGER, PAUSES, PII_KEY]);
  });

  it("no workflow can pause: only the ledger's", async () => {
    const assembled = await applicationOf(NoteLoggedApplication);

    expect(assemblyWarningsOf(assembled).map((warning) => warning.code)).toEqual([
      "application.in-memory-cost-ledger",
    ]);
  });

  it("durable stores listed: none of the stores' (the PII key's stays: no pseudonymKey)", async () => {
    const app = await createApp(DurableLoggedApplication, offline);
    await app.close();

    expect(app.warnings).toEqual([PII_KEY]);
    expect(
      logged.filter((entry) => entry.level === LogLevel.Warn).map((entry) => entry.message),
    ).toEqual([PII_KEY]);
  });

  it("#644: only the pause records listed — the warning names the checkpoints, the one left in memory", async () => {
    const assembled = await applicationOf(LoggedApplication);
    const providers = [...assembled.providers, SqlitePausedExecutionRepository];

    const pauses = assemblyWarningsOf({ ...assembled, providers }).filter(
      (warning) => warning.code === "application.in-memory-pauses",
    );

    expect(pauses.map((warning) => warning.message)).toEqual([
      "in-memory pauses: the checkpoints (BaseCheckpointSaver — list SqliteCheckpointSaver) are kept in memory — another application instance cannot resume a pause and it is lost on restart",
    ]);
  });

  it("#644: only the checkpoints listed — the warning names the pause records, the one left in memory", async () => {
    const assembled = await applicationOf(LoggedApplication);
    const providers = [...assembled.providers, SqliteCheckpointSaver];

    const pauses = assemblyWarningsOf({ ...assembled, providers }).filter(
      (warning) => warning.code === "application.in-memory-pauses",
    );

    expect(pauses.map((warning) => warning.message)).toEqual([
      "in-memory pauses: the pause records (PausedExecutionRepository — list SqlitePausedExecutionRepository) are kept in memory — another application instance cannot resume a pause and it is lost on restart",
    ]);
  });
});

describe("#401 PR 1: kept execution history in memory warns", () => {
  it("executionRecordRetention on the built-in in-memory store: the history's warning", async () => {
    const assembled = await applicationOf(HistoryDeskApplication);

    expect(assemblyWarningsOf(assembled).map((warning) => warning.code)).toContain(
      "application.in-memory-execution-history",
    );
  });

  it("no executionRecordRetention, or SqliteExecutionHistoryRepository listed: none", async () => {
    const plain = await applicationOf(NoteLoggedApplication);
    const listed = await applicationOf(HistoryDeskApplication);
    const sqlite = assemblyWarningsOf({
      ...listed,
      providers: [...listed.providers, SqliteExecutionHistoryRepository],
    });

    const codes = [...assemblyWarningsOf(plain), ...sqlite].map((warning) => warning.code);
    expect(codes).not.toContain("application.in-memory-execution-history");
  });
});

describe("#120 S94: no application key → a key of the instance, and a warning", () => {
  it("not set and not needed: the start goes on, the warning in app.warnings and the log", async () => {
    const app = await createApp(NoteLoggedApplication, offline);
    await app.close();

    expect(app.warnings).toContain(PII_KEY);
    expect(logged.map((entry) => entry.message)).toContain(PII_KEY);
  });

  it("#644: nothing makes a PII token — no policy, no sensitive field, no text start — no warning", async () => {
    const assembled = await applicationOf(OrderApplication);

    expect(applicationWarningsOf(assembled).map((warning) => warning.code)).toEqual([
      "application.in-memory-cost-ledger",
    ]);
  });

  it("#644: a sensitive field of a path's DTO, or a PII policy, makes tokens: the warning", async () => {
    const sensitive = await applicationOf(QuestionsApplication); // PurchaseQuestionDto.requester
    const policies = await applicationOf(ClinicApplication);

    for (const assembled of [sensitive, policies])
      expect(applicationWarningsOf(assembled).map((warning) => warning.code)).toContain(
        "application.pii-instance-key",
      );
  });

  it("pseudonymKey set: no warning", async () => {
    const processEnv = { PII_APP_KEY: "k", PII_TEST_PSEUDONYM_KEY: "own" };
    const app = await createApp(KeyedApplication, { ...offline, processEnv });
    await app.close();

    expect(app.warnings).not.toContain(PII_KEY);
  });

  it("agboss check reads it from the declaration — an error under --strict (the CLI's tests)", async () => {
    const unkeyed = await applicationOf(ClinicApplication);

    expect(applicationWarningsOf(unkeyed).map((warning) => warning.code)).toContain(
      "application.pii-instance-key",
    );
  });
});

const test = testWith(LoggedApplication);

describe("#261 AC14, #120 S94: silent in tests", () => {
  test("testWith logs no warning, though the application has them", async ({ app }) => {
    await app.ready();

    expect(logged).toEqual([]);
  });

  it("an instance built as testWith builds it (its test key, #334) makes tokens with a fixed key: no PII key warning", async () => {
    const assembled = await applicationOf(QuestionsApplication);
    const seams = { quiet: true, piiTestKey: TEST_PSEUDONYM_KEY };
    const { app } = await buildApplication(assembled, offline, seams);
    await app.close();

    expect(app.warnings).not.toContain(PII_KEY);
  });
});
