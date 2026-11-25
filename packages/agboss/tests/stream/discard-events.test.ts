/**
 * #1006 AC1, AC2: every delta names its step; what a judge rejects, a refused move or a broken call
 * produced is retracted by a `discarded` event, once; the kept deltas, joined, are the reply.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { describe, expect } from "vitest";
import {
  StreamDiscardReason,
  StreamEventKind,
  type ExecutionStreamEvent,
  type StreamStep,
} from "../../src/run/types.js";
import { failWith, ModelFailure, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { keptText } from "./kept-text.js";
import { AuditJudge, AuditJudgeApplication, AuditStart, AuditWriter } from "./writer.fixture.js";

const test = testWith(AuditJudgeApplication);

const stepOf = (executionId: string, attempt: number): StreamStep => ({
  agent: "audit-writer-agent",
  visit: 1,
  branch: executionId,
  attempt,
});

describe("#1006: a judge rejects an attempt", () => {
  test("AC1, AC2: delta(1), discarded(1, judge-rejected), delta(2); the kept text is the output", async ({
    app,
    mockModel,
  }) => {
    mockModel(AuditWriter).thenReturn(replyWith("BAD DRAFT"), replyWith("Good answer."));
    mockModel(AuditJudge).thenReturn(replyWith("FAIL"), replyWith("PASS"));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      AuditStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    const step = (attempt: number) => stepOf(done.executionId, attempt);
    expect(events).toEqual([
      { kind: StreamEventKind.TextDelta, delta: "BAD DRAFT", step: step(1) },
      { kind: StreamEventKind.Discarded, step: step(1), reason: StreamDiscardReason.JudgeRejected },
      { kind: StreamEventKind.TextDelta, delta: "Good answer.", step: step(2) },
    ]);
    expect(done.output).toEqual({ text: "Good answer." });
    expect(keptText(events)).toBe("Good answer.");
  });

  test("AC1: the last rejection fails the run — the draft is retracted once, never twice", async ({
    app,
    mockModel,
  }) => {
    mockModel(AuditWriter).thenReturn(replyWith("ONE"), replyWith("TWO"));
    mockModel(AuditJudge).thenReturn(replyWith("FAIL"), replyWith("FAIL"));
    const events: ExecutionStreamEvent[] = [];

    const failure = await execute(
      app,
      AuditStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(StepError.QualityGate);
    expect(
      events.map((event) =>
        event.kind === StreamEventKind.ToolCall
          ? ""
          : `${event.kind}:${String(event.step.attempt)}`,
      ),
    ).toEqual(["text-delta:1", "discarded:1", "text-delta:2", "discarded:2"]);
    expect(keptText(events)).toBe("");
  });

  test("AC1: a judge that cannot answer fails the visit — the reply is retracted as failed", async ({
    app,
    mockModel,
  }) => {
    mockModel(AuditWriter).thenReturn(replyWith("A reply."));
    mockModel(AuditJudge).thenReturn(failWith(ModelFailure.Timeout));
    const events: ExecutionStreamEvent[] = [];

    await expect(
      execute(app, AuditStart, { text: "Q" }, { onStream: (event) => events.push(event) }),
    ).rejects.toThrow();

    expect(events.map((event) => event.kind)).toEqual([
      StreamEventKind.TextDelta,
      StreamEventKind.Discarded,
    ]);
    expect(events[1]).toMatchObject({ reason: StreamDiscardReason.Failed });
  });
});

describe("#1006: a refused move", () => {
  test("AC1: a PII token nobody gave — the attempt is discarded as invalid, the retry is the answer", async ({
    app,
    mockModel,
  }) => {
    mockModel(AuditWriter).thenReturn(replyWith("Write to <email:abcdef>."), replyWith("Fine."));
    mockModel(AuditJudge).thenReturn(replyWith("PASS"));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      AuditStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(events.map((event) => event.kind)).toEqual([
      StreamEventKind.TextDelta,
      StreamEventKind.Discarded,
      StreamEventKind.TextDelta,
    ]);
    expect(events[1]).toMatchObject({
      kind: StreamEventKind.Discarded,
      reason: StreamDiscardReason.InvalidAnswer,
    });
    expect(done.output).toEqual({ text: "Fine." });
    expect(keptText(events)).toBe("Fine.");
  });
});
