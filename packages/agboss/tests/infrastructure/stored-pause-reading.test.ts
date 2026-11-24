/**
 * #934: what a store outside the core hands over — a pause's JSON as it parsed it — is read by the
 * core's `pauseRecordOfJson`, the answer it embeds too: the stores rely on that one call (the SQLite
 * pause row reads through it too, so its tests catch a removal as well, but this one names it). Also
 * the answer-log entry and the kept history record a store parsed. The rows are 0.1.1's.
 */
import { describe, expect, it } from "vitest";
import { PauseAnswerer } from "../../src/index.js";
import {
  executionHistoryRecordOfJson,
  pauseAnswerRecordOfValue,
  pauseRecordOfJson,
  StoredNamesUnreadableError,
} from "../../src/stores/index.js";
import { answerLogEntry, historyRecord } from "./sqlite/stored-rows.fixtures.js";

const PAUSE = {
  pauseId: "p1",
  tenantId: "default",
  threadId: "t-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "desk-workflow",
  stepKey: "run-1:s:1",
  nodeId: "clerk-agent",
  visitNumber: 1,
  copyNumber: 1,
  kind: "approval",
  step: "clerk-agent",
  channel: "refund-approval-channel",
  answerer: "channel",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
  status: "resolved",
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
  resolution: "replied",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  answer: { decision: { approved: true }, answeredBy: "manager-17" },
};

describe("a store's parsed JSON is read through the core", () => {
  it("a pause: its answerer is who may answer, the answer's answeredBy is the person", () => {
    expect(pauseRecordOfJson(PAUSE)).toMatchObject({
      answerer: PauseAnswerer.Channel,
      answer: { decision: { approved: true }, answeredBy: "manager-17" },
    });
  });

  it("a question's ask is the role's own", () => {
    const stored = {
      ...PAUSE,
      answerer: "thread-owner",
      kind: "question",
      ask: { topic: "free" },
      answer: { decision: 1, answeredBy: "alice" },
    };

    expect(pauseRecordOfJson(stored)).toMatchObject({
      answerer: PauseAnswerer.ThreadOwner,
      ask: { topic: "free" },
      answer: { answeredBy: "alice" },
    });
  });

  it("what #935 added is kept: the deadline fields and the first close", () => {
    const closedFirst = { resolution: "replied", resolvedAt: "2026-01-05T09:05:00.000Z" };

    const pause = pauseRecordOfJson({
      ...PAUSE,
      expiresAt: "2026-01-06T00:00:00.000Z",
      expiryBound: "pause",
      closedFirst,
    });

    expect(pause).toMatchObject({ expiresAt: "2026-01-06T00:00:00.000Z", closedFirst });
  });

  it.each([
    ["a pause with no kind of answerer", { answerer: undefined }, "answerer"],
    ["an approval whose ask is no tool call", { ask: { topic: "free" } }, "ask"],
    ["an answer that is a text", { answer: "sk-live-PLANTED" }, "answer"],
    [
      "an answer whose person is an object",
      { answer: { decision: 1, answeredBy: {} } },
      "answer.answeredBy",
    ],
  ])("%s is unreadable: its id and the field", (_name, change, field) => {
    const read = (): unknown => pauseRecordOfJson({ ...PAUSE, ...change });

    expect(read).toThrow(StoredNamesUnreadableError);
    expect(read).toThrow(new RegExp(`pauseId p1.*${field}`));
    expect(read).not.toThrow(/sk-live-PLANTED/);
  });

  it("an answer-log entry and a kept history record are read the same way", () => {
    expect(pauseAnswerRecordOfValue(answerLogEntry)).toMatchObject({
      answerer: PauseAnswerer.Channel,
      answeredBy: "manager-17",
      responder: "manager-17",
    });
    expect(executionHistoryRecordOfJson(historyRecord).children[0]?.pauses[0]).toMatchObject({
      answerer: PauseAnswerer.ThreadOwner,
      answeredBy: "alice",
    });
  });
});

describe("0.1.0 is refused, never defaulted", () => {
  const refused = (read: () => unknown, field: string): void => {
    let error: unknown;
    try {
      read();
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(StoredNamesUnreadableError);
    if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
    expect(error.message).toContain(field);
  };

  it.each([
    [
      "answeredBy as the kind, no answerer",
      { answerer: undefined, answeredBy: "channel" },
      "answerer",
    ],
    ["answeredBy beside the answerer", { answeredBy: "channel" }, "answeredBy"],
    ["no copyNumber", { copyNumber: undefined }, "copyNumber"],
    ["no askedAt", { askedAt: undefined }, "askedAt"],
    [
      "an answer with 0.1.0's answerer",
      { answer: { decision: 1, answerer: "manager-17" } },
      "answer.answerer",
    ],
  ])("a pause with %s", (_name, change, field) => {
    refused(() => pauseRecordOfJson({ ...PAUSE, ...change }), field);
  });

  it("a log entry with 0.1.0's answeredBy as the kind and no answerer", () => {
    refused(
      () =>
        pauseAnswerRecordOfValue({
          ...answerLogEntry,
          answerer: undefined,
          answeredBy: "channel",
          responder: "manager-17",
        }),
      "answerer",
    );
  });
});
