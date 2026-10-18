/**
 * #261 AC13 — the start log: once per instance, two kinds of lines only — what started, and the
 * worst case of one call of each start in counts — then the startup warnings. Only the decorators
 * are read: no `maxSpend()` is called at start, nothing per tenant is logged. Tests log none of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { LogLevel } from "../../src/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { logged, resetLogged } from "../helpers/log.js";
import {
  LoggedApplication,
  maxSpendCalls,
  NoteWorkflowStart,
  ScribeAgent,
} from "./fixtures/logged.application.js";
import { execute } from "../helpers/flow.js";

const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };

beforeEach(() => {
  resetLogged();
  maxSpendCalls.length = 0;
});

afterEach(resetLogged);

describe("#261 AC13: the start log", () => {
  it("what started, then the worst case of one call of each start, then the warnings", async () => {
    const app = await createApp(LoggedApplication, offline);
    await app.close();

    const info = logged.filter((entry) => entry.level === LogLevel.Info);
    expect(info.map((entry) => entry.code)).toEqual([
      "app.started",
      "app.worst-case",
      "app.worst-case",
    ]);
    expect(info[0]?.message).toMatch(
      /^Started logged-application 2\.3\.0 — environment dev, host \S+, process \d+$/,
    );
    expect(info.slice(1).map((entry) => entry.message)).toEqual([
      "Worst case of one note-workflow-start call: 1 workflow execution, 1 at the same time, 1 agent and router steps",
      "Worst case of one send-workflow-start call: 1 workflow execution, 1 at the same time, 1 agent and router steps",
    ]);
    expect(
      logged.filter((entry) => entry.level === LogLevel.Warn).map((entry) => entry.code),
    ).toEqual(["app.warning", "app.warning"]);
  });

  it("calls no maxSpend() and logs nothing per tenant", async () => {
    const app = await createApp(LoggedApplication, offline);
    await app.close();

    expect(maxSpendCalls).toEqual([]);
    expect(logged.every((entry) => entry.tenantId === undefined)).toBe(true);
    // no amount, no budget named: the framework never reads maxSpend() at start
    expect(logged.some((entry) => /\$|logged-\w+-budget/.test(entry.message))).toBe(false);
  });

  it("each entry carries the time of the application's clock", async () => {
    const app = await createApp(LoggedApplication, offline);
    await app.close();

    expect(logged.every((entry) => entry.time instanceof Date)).toBe(true);
  });
});

const test = testWith(LoggedApplication);

describe("#261 AC13: tests log no start", () => {
  test("an application under testWith writes no start line and no warning to its logger", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ScribeAgent).thenReturn(replyWith("noted"));

    await execute(app, NoteWorkflowStart, { text: "note" });

    expect(logged).toEqual([]);
    expect(maxSpendCalls).toEqual(["application", "tenant", "execution"]);
  });
});
