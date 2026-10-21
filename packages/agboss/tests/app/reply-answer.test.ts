/**
 * #267 PR 3: a reply read outside an application's budgets (a workflow run on its own) — no meter,
 * the reader called with the trace's callbacks; an unreadable reply throws its error.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { describe, expect, it } from "vitest";
import { replyAnsweringOf, type ReplyAnsweringParts } from "../../src/app/reply-answer.js";
import type { ReplyCall, ReplyReading } from "../../src/channels/reply-reader.js";
import { UninterpretableReplyError } from "../../src/channels/channel-role.decorator.js";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { PauseStatus, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { testFrame } from "../helpers/frame.js";

class TraceHandler extends BaseCallbackHandler {
  name = "trace-handler";
}

const pause: PauseRecord = {
  pauseId: "p-1",
  tenantId: "acme",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "desk-workflow",
  stepKey: "run-1:clerk-agent:1:call-1",
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  agent: "clerk-agent",
  channel: "refund-approval-channel",
  answeredBy: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "refund", arguments: {}, summary: "refund" },
  status: PauseStatus.Pending,
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
};

/** The deps of a workflow on its own: no budgets, tracing on. */
const handler = new TraceHandler();
const traced = new Array<unknown>();
const parts: ReplyAnsweringParts = {
  workflow: "desk-workflow",
  treeStateOf: () => Promise.resolve({}),
  frameOf: () => Promise.resolve(testFrame()),
  piiOf: () => ({ policies: new PiiPolicySet([], ""), known: {} }),
  tracing: {
    callbacks: (context: unknown) => {
      traced.push(context);
      return [handler];
    },
    sessionUrl: () => undefined,
    shutdown: () => Promise.resolve(),
  },
};

describe("#267 PR 3: a reply read without budgets", () => {
  it("the reader gets the trace's callbacks; no budget is checked before its call", async () => {
    const calls: ReplyCall[] = [];
    const reader = async (call: ReplyCall): Promise<ReplyReading> => {
      calls.push(call);
      await call.beforeModelCall();
      return { kind: "read", decision: { approved: true }, usage: [] };
    };

    const read = await replyAnsweringOf(parts, reader)(pause, "yes", undefined, (d) => d);

    expect(read).toEqual({ decision: { approved: true }, usage: [] });
    expect(calls[0]?.callbacks).toEqual([handler]);
    expect(traced).toEqual([
      { bundle: "desk-workflow", threadId: "thread-1", runId: "run-1", tenantId: "acme" },
    ]);
  });

  it("an unreadable reply throws the reader's error", async () => {
    const error = new UninterpretableReplyError("no answer", { reason: "no answer" });
    const reader = (): Promise<ReplyReading> =>
      Promise.resolve({ kind: "unreadable", error, usage: [] });

    const read = replyAnsweringOf(parts, reader)(pause, "hmm", undefined, (d) => d);

    await expect(read).rejects.toBe(error);
  });
});
