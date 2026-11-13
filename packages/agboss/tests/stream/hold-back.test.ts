/**
 * #1006 AC3: an agent with a blocking output check — an output guardrail, a PII block rule — has
 * its text held until the checks passed: a refused or rejected answer never reaches the stream,
 * not one byte, and nothing needs retracting.
 */
import { describe, expect } from "vitest";
import { GuardrailBlockedError, PiiRefusedError } from "../../src/index.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { FlowJudge } from "./agents.fixture.js";
import {
  CardOnlyAgent,
  CardStart,
  EchoTool,
  GuardedAgent,
  GuardedApplication,
  GuardedStart,
} from "./guarded.fixture.js";
import { keptText } from "./kept-text.js";

const test = testWith(GuardedApplication);

const failureOf = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1006: a blocking output guardrail holds the text back", () => {
  test("AC3: a blocked answer: GuardrailBlockedError, zero events", async ({ app, mockLlm }) => {
    mockLlm(GuardedAgent).thenReturn(replyWith("Here is the FORBIDDEN thing."));
    mockLlm(FlowJudge).thenReturn(replyWith("PASS"));
    const events: ExecutionStreamEvent[] = [];

    const failure = await failureOf(
      execute(app, GuardedStart, { text: "Q" }, { onStream: (event) => events.push(event) }),
    );

    expect(failure).toBeInstanceOf(GuardrailBlockedError);
    expect(events).toEqual([]);
  });

  test("AC3: an answer that passes goes out after the checks, with its step; kept text = output", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GuardedAgent).thenReturn(replyWith("  A fine answer.\n"));
    mockLlm(FlowJudge).thenReturn(replyWith("PASS"));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      GuardedStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(events).toEqual([
      {
        kind: "textDelta",
        delta: "  A fine answer.\n",
        step: { agent: "guarded-agent", visit: 1, branch: done.executionId, attempt: 1 },
      },
    ]);
    expect(done.output).toEqual({ text: "A fine answer." });
  });

  test("AC3: a draft the judge rejects is never shown, not even as a retraction; the retry goes out", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GuardedAgent).thenReturn(replyWith("BAD DRAFT"), replyWith("Good answer."));
    mockLlm(FlowJudge).thenReturn(replyWith("FAIL"), replyWith("PASS"));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      GuardedStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(events.map((event) => event.kind)).toEqual(["textDelta"]);
    expect(events[0]).toMatchObject({ delta: "Good answer.", step: { attempt: 2 } });
    expect(done.output).toEqual({ text: keptText(events) });
    expect(JSON.stringify(events)).not.toContain("BAD DRAFT");
  });

  test("AC3: text before a tool call is never shown; the tool turn leaves nothing to retract", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(GuardedAgent).thenReturn(callTool(EchoTool, { text: "x" }), replyWith("Done."));
    mockLlm(FlowJudge).thenReturn(replyWith("PASS"));
    const events: ExecutionStreamEvent[] = [];

    await execute(app, GuardedStart, { text: "Q" }, { onStream: (event) => events.push(event) });

    expect(events.filter((event) => event.kind === "discarded")).toEqual([]);
    expect(events.filter((event) => event.kind === "textDelta")).toMatchObject([
      { delta: "Done.", step: { attempt: 2 } },
    ]);
  });
});

describe("#1006: a PII block rule holds the text back", () => {
  test("AC3: a card number in the answer: the run is refused, the stream saw nothing", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(CardOnlyAgent).thenReturn(replyWith("Your card is 4242 4242 4242 4242."));
    const events: ExecutionStreamEvent[] = [];

    const failure = await failureOf(
      execute(app, CardStart, { text: "Q" }, { onStream: (event) => events.push(event) }),
    );

    expect(failure).toBeInstanceOf(PiiRefusedError);
    expect(events).toEqual([]);
  });

  test("AC3: an answer without a card goes out whole after the check", async ({ app, mockLlm }) => {
    mockLlm(CardOnlyAgent).thenReturn(replyWith("No card here."));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      CardStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: keptText(events) });
  });
});
