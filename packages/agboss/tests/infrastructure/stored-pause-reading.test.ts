/**
 * #934: what a store outside the core hands over — a pause's JSON as it parsed it — is read by the
 * core's `pauseRecordOfJson`, the answer it embeds too: the stores rely on that one call (the SQLite
 * pause row reads through it too, so its tests catch a removal as well, but this one names it). Also
 * the answer-log entry and the kept history record a store parsed. The rows are 0.1.1's.
 */
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { describe, expect, it } from "vitest";
import { PauseRespondent } from "../../src/index.js";
import {
  executionHistoryRecordOfJson,
  pauseAnswerRecordOfValue,
  pauseRecordOfJson,
} from "../../src/stores/index.js";
import { answerLogEntry, historyRecord, historyRecordWith } from "./sqlite/stored-rows.fixtures.js";

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
  target: "refund-tool-approval",
  channel: "refund-approval-channel",
  respondent: "delegate",
  input: { orderId: "7" },
  toolCall: { callId: "call-1", tool: "refund", summary: "refund 7" },
  status: "resolved",
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
  resolution: "replied",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  trail: [{ action: "opened", at: "2026-01-05T09:00:00.000Z", target: "refund-approval-channel" }],
  answer: { decision: { approved: true }, actor: { id: "manager-17", orgId: "holding-hq" } },
};

describe("a store's parsed JSON is read through the core", () => {
  it("a pause: its respondent is who may answer, the answer's actor is who answered", () => {
    expect(pauseRecordOfJson(PAUSE)).toMatchObject({
      respondent: PauseRespondent.Delegate,
      answer: { decision: { approved: true }, actor: { id: "manager-17", orgId: "holding-hq" } },
    });
  });

  it("a question's input is the role's own", () => {
    const stored = {
      ...PAUSE,
      respondent: "owner",
      kind: "external-task",
      input: { topic: "free" },
      toolCall: undefined,
      answer: { decision: 1, actor: { id: "alice" } },
    };

    expect(pauseRecordOfJson(stored)).toMatchObject({
      respondent: PauseRespondent.Owner,
      input: { topic: "free" },
      answer: { actor: { id: "alice" } },
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
    ["a pause with no kind of respondent", { respondent: undefined }, "respondent"],
    ["an approval with no tool call", { toolCall: undefined }, "toolCall"],
    ["a question that names a tool call", { kind: "external-task" }, "toolCall"],
    ["a pause with no chain of custody", { trail: undefined }, "trail"],
    ["a pause with an empty chain of custody", { trail: [] }, "trail"],
    ["an empty list of assignees", { assignees: [] }, "assignees"],
    ["an answer that is a text", { answer: "sk-live-PLANTED" }, "answer"],
    [
      "an answer whose person is an object",
      { answer: { decision: 1, actor: { id: {} } } },
      "answer.actor.id",
    ],
  ])("%s is unreadable: its id and the field", (_name, change, field) => {
    const read = (): unknown => pauseRecordOfJson({ ...PAUSE, ...change });

    expect(read).toThrow(StoreError.UnreadableRecord);
    expect(read).toThrow(new RegExp(`pause ${pauseKeyOf("default", "p1")}.*${field}`));
    expect(read).not.toThrow(/sk-live-PLANTED/);
  });

  it("an answer-log entry and a kept history record are read the same way", () => {
    expect(pauseAnswerRecordOfValue(answerLogEntry)).toMatchObject({
      respondent: PauseRespondent.Delegate,
      actor: { id: "manager-17" },
    });
    expect(executionHistoryRecordOfJson(historyRecord).children[0]?.pauses[0]).toMatchObject({
      respondent: PauseRespondent.Owner,
      actor: { id: "alice" },
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
    expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
    if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
    expect(error.message).toContain(field);
  };

  it.each([
    [
      "answeredBy as the kind, no respondent",
      { respondent: undefined, answeredBy: "channel" },
      "respondent",
    ],
    ["answeredBy beside the respondent", { answeredBy: "channel" }, "answeredBy"],
    ["0.1.0's ask", { ask: { topic: "free" } }, "ask"],
    ["0.1.0's one assignee", { assignee: "deputy-3" }, "assignee"],
    [
      "0.1.0's answer.answeredBy",
      { answer: { decision: 1, answeredBy: "manager-17" } },
      "answer.answeredBy",
    ],
    ["0.1.0's answer.byChannel", { answer: { decision: 1, byChannel: true } }, "answer.byChannel"],
    ["no copyNumber", { copyNumber: undefined }, "copyNumber"],
    ["no askedAt", { askedAt: undefined }, "askedAt"],
    [
      "an answer with 0.1.0's respondent",
      { answer: { decision: 1, respondent: "manager-17" } },
      "answer.respondent",
    ],
  ])("a pause with %s", (_name, change, field) => {
    refused(() => pauseRecordOfJson({ ...PAUSE, ...change }), field);
  });

  it("a log entry or a kept history record with 0.1.0's responder is refused, the field named (#1307d)", () => {
    refused(
      () => pauseAnswerRecordOfValue({ ...answerLogEntry, responder: "manager-17" }),
      "responder",
    );
    const kept = historyRecordWith((tree) => {
      const [entry] = tree.children[0]?.pauses ?? [];
      Object.assign(entry ?? {}, { responder: "alice" });
    });
    refused(() => executionHistoryRecordOfJson(kept), "responder");
  });

  it("a log entry with 0.1.0's answeredBy as the kind and no respondent", () => {
    refused(
      () =>
        pauseAnswerRecordOfValue({
          ...answerLogEntry,
          respondent: undefined,
          answeredBy: "channel",
          responder: "manager-17",
        }),
      "respondent",
    );
  });
});
