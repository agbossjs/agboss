/**
 * #261 AC14 — assembly warnings: tenant or application budgets on the built-in in-memory cost ledger,
 * and pauses possible with the built-in in-memory paused executions or checkpoints. In
 * `app.warnings` and the start log; errors under `agboss check --strict` (the CLI's tests); silent
 * in tests (`testWith`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { applicationOf } from "../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
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

const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };

beforeEach(resetLogged);

describe("#261 AC14: in-memory ledger and pauses warn", () => {
  it("the built-in in-memory ledger with tenant and application budgets, and pauses in memory: both", async () => {
    const app = await createApp(LoggedApplication, offline);
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

  it("durable stores listed: none", async () => {
    const app = await createApp(DurableLoggedApplication, offline);
    await app.close();

    expect(app.warnings).toEqual([]);
    expect(logged.filter((entry) => entry.level === LogLevel.Warn)).toEqual([]);
  });
});

const test = testWith(LoggedApplication);

describe("#261 AC14: silent in tests", () => {
  test("testWith logs no warning, though the application has them", async ({ app }) => {
    await app.ready();

    expect(logged).toEqual([]);
  });
});
