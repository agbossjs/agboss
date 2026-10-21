/**
 * #261 AC14 — assembly warnings: tenant or application budgets on the built-in in-memory cost ledger,
 * and pauses possible with the built-in in-memory paused executions or checkpoints; #120 S94 — PII
 * tokens on a key of the instance (no `pseudonymKey`). In `app.warnings` and the start log; errors
 * under `agboss check --strict` (the CLI's tests); silent in tests (`testWith`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildApplication, createApp } from "../../src/application/create-app.js";
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
import {
  DurableLoggedApplication,
  LoggedApplication,
  NoteLoggedApplication,
} from "./fixtures/logged.application.js";

const LEDGER =
  "[application.in-memory-cost-ledger] in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart";
const PAUSES =
  "[application.in-memory-pauses] in-memory pauses: another application instance cannot resume them and they are lost on restart";
const PII_KEY =
  "[application.pii-instance-key] no @Application({ pseudonymKey }): sensitive fields and policies without their own key make PII tokens with a key of this instance — one value gets another token on each instance, so logs and traces compare across instances only with pseudonymKey";

const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };

beforeEach(resetLogged);

describe("#261 AC14: in-memory ledger and pauses warn", () => {
  it("the built-in in-memory ledger with tenant and application budgets, and pauses in memory: both", async () => {
    const app = await createApp(LoggedApplication, offline);
    await app.close();

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
});

describe("#120 S94: no application key → a key of the instance, and a warning", () => {
  it("not set and not needed: the start goes on, the warning in app.warnings and the log", async () => {
    const app = await createApp(NoteLoggedApplication, offline);
    await app.close();

    expect(app.warnings).toContain(PII_KEY);
    expect(logged.map((entry) => entry.message)).toContain(PII_KEY);
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

  it("an instance built as testWith builds it (quiet) makes tokens with a fixed key: no PII key warning", async () => {
    const assembled = await applicationOf(NoteLoggedApplication);
    const { app } = await buildApplication(assembled, offline, { quiet: true });
    await app.close();

    expect(app.warnings).not.toContain(PII_KEY);
  });
});
