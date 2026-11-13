/**
 * #934: what a store outside the core hands over — a pause's JSON as it parsed it — is read by the
 * core's `pauseRecordOfJson`, which normalises the answer it embeds itself: the stores rely on that
 * one call (the SQLite pause row reads through it too, so its tests catch a removal as well, but
 * this one names it). Also the answer-log entry and the kept history record a store parsed.
 */
import { describe, expect, it } from "vitest";
import { PauseAnswerer } from "../../src/index.js";
import {
  executionHistoryRecordOfJson,
  pauseAnswerRecordOfValue,
  pauseRecordOfJson,
  StoredNamesUnreadableError,
} from "../../src/stores/index.js";
import { oldAnswerLogEntry, oldHistoryRecord } from "./sqlite/pause-names-0.1.0.fixtures.js";

const OLD_PAUSE = {
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
  answeredBy: "channel",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
  status: "resolved",
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
  resolution: "replied",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  answer: { decision: { approved: true }, answerer: "manager-17" },
};

describe("a store's parsed JSON is read through the core, either shape of the names", () => {
  it("a 0.1.0 pause: its answeredBy is its answerer, the answer's answerer is the person", () => {
    const pause = pauseRecordOfJson(OLD_PAUSE);

    expect(pause).toMatchObject({
      answerer: PauseAnswerer.Channel,
      answer: { decision: { approved: true }, answeredBy: "manager-17" },
    });
    expect(pause).not.toHaveProperty("answeredBy");
    expect(pause.answer).not.toHaveProperty("answerer");
  });

  it("a new pause is read as it is, and a question's ask is the role's own", () => {
    const stored = {
      ...OLD_PAUSE,
      answeredBy: undefined,
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
      ...OLD_PAUSE,
      expiresAt: "2026-01-06T00:00:00.000Z",
      expiryBound: "pause",
      closedFirst,
    });

    expect(pause).toMatchObject({ expiresAt: "2026-01-06T00:00:00.000Z", closedFirst });
  });

  it.each([
    ["a pause with no kind of answerer", { answeredBy: undefined }, "answerer"],
    ["an approval whose ask is no tool call", { ask: { topic: "free" } }, "ask"],
    ["an answer that is a text", { answer: "sk-live-PLANTED" }, "answer"],
    [
      "an answer whose person is an object",
      { answer: { decision: 1, answerer: {} } },
      "answer.answerer",
    ],
  ])("%s is unreadable: its id and the field", (_name, change, field) => {
    const read = (): unknown => pauseRecordOfJson({ ...OLD_PAUSE, ...change });

    expect(read).toThrow(StoredNamesUnreadableError);
    expect(read).toThrow(new RegExp(`pauseId p1.*${field}`));
    expect(read).not.toThrow(/sk-live-PLANTED/);
  });

  it("an answer-log entry and a kept history record are read the same way", () => {
    expect(pauseAnswerRecordOfValue(oldAnswerLogEntry)).toMatchObject({
      answerer: PauseAnswerer.Channel,
      answeredBy: "manager-17",
      responder: "manager-17",
    });
    expect(executionHistoryRecordOfJson(oldHistoryRecord).children[0]?.pauses[0]).toMatchObject({
      answerer: PauseAnswerer.ThreadOwner,
      answeredBy: "alice",
    });
  });
});
