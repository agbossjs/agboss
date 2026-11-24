/**
 * #261 AC14 — assembly warnings: tenant or application budgets on the built-in in-memory cost ledger,
 * and pauses possible with the built-in in-memory paused executions or checkpoints. In `app.warnings` and the start log; errors
 * under `agboss check --strict` (the CLI's tests); silent in tests (`testWith`).
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApplication } from "../../src/application/create-app.js";
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

const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };

beforeEach(resetLogged);

describe("#261 AC14: in-memory ledger and pauses warn", () => {
  it("the built-in in-memory ledger with tenant and application budgets, and pauses in memory: both", async () => {
    const app = await createTestAppWith(LoggedApplication, offline);
    await app.close();

    expect(app.warnings).toEqual([LEDGER, PAUSES]);
    expect(
      logged.filter((entry) => entry.level === LogLevel.Warn).map((entry) => entry.message),
    ).toEqual([LEDGER, PAUSES]);
  });

  it("no workflow can pause: only the ledger's", async () => {
    const assembled = await applicationOf(NoteLoggedApplication);

    expect(assemblyWarningsOf(assembled).map((warning) => warning.code)).toEqual([
      "application.in-memory-cost-ledger",
    ]);
  });

  it("durable stores listed: none of the stores' warnings", async () => {
    const app = await createTestAppWith(DurableLoggedApplication, offline);
    await app.close();

    expect(app.warnings).toEqual([]);
    expect(
      logged.filter((entry) => entry.level === LogLevel.Warn).map((entry) => entry.message),
    ).toEqual([]);
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
  it("retention.executionRecords on the built-in in-memory store: the history's warning", async () => {
    const assembled = await applicationOf(HistoryDeskApplication);

    expect(assemblyWarningsOf(assembled).map((warning) => warning.code)).toContain(
      "application.in-memory-execution-history",
    );
  });

  it("no retention.executionRecords, or SqliteExecutionHistoryRepository listed: none", async () => {
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

describe("#1301: no PII secret and nothing tokenizes: a key of the instance, no warning", () => {
  it("the start goes on and says nothing about a key", async () => {
    const app = await createTestAppWith(NoteLoggedApplication, offline);
    await app.close();

    expect(app.warnings.some((warning) => warning.includes("pii"))).toBe(false);
    expect(logged.some((entry) => entry.message.includes("pii-instance-key"))).toBe(false);
  });

  it("no PII warning for an application with PII policies or sensitive fields either (a secret is required only to tokenize)", async () => {
    for (const application of [QuestionsApplication, ClinicApplication, OrderApplication]) {
      const assembled = await applicationOf(application);
      expect(
        applicationWarningsOf(assembled).filter((warning) =>
          warning.code.startsWith("application.pii"),
        ),
      ).toEqual([]);
    }
  });

  it("a key named: no warning", async () => {
    const processEnv = { PII_APP_KEY: "k", PII_TEST_PSEUDONYM_KEY: "own" };
    const app = await createTestAppWith(KeyedApplication, { ...offline, processEnv });
    await app.close();

    expect(app.warnings.some((warning) => warning.includes("pii"))).toBe(false);
  });
});

const test = testWith(LoggedApplication);

describe("#261 AC14, #120 S94: silent in tests", () => {
  test("testWith logs no warning, though the application has them", async ({ app }) => {
    await app.ready();

    expect(logged).toEqual([]);
  });

  it("an instance built as testWith builds it (its test key, #334) makes tokens with a fixed key", async () => {
    const assembled = await applicationOf(QuestionsApplication);
    const seams = { quiet: true, piiTestKey: TEST_PSEUDONYM_KEY };
    const { app } = await buildApplication(assembled, offline, seams);
    await app.close();

    expect(app.warnings.some((warning) => warning.includes("pii"))).toBe(false);
  });
});
