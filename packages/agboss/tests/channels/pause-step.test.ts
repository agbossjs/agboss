/**
 * #267 AC3 / S35 — the pause step on its own: a pause is recorded by its step's key before its
 * channel is asked, with a random 128-bit `pauseId` made once; a step tried again after a crash
 * between the record and `send` asks again with the same `pauseId`; a reply that resolved the pause
 * while `send` was still returning is taken at once; `decided(…)` leaves no record. Through the
 * application: `tests/channels/parallel-pauses.test.ts` (no second `send` on re-entry) and
 * `tests/channels/concurrent-resume.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import type { ChannelSenderAsk } from "../../src/channels/channel-sender.js";
import { PauseStatus } from "../../src/infrastructure/pause-record.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { pauseStep, PauseWithdrawnError, type PauseChannel } from "../../src/flow/runtime/pause.js";
import { testFrame } from "../helpers/frame.js";

const question = {
  agent: "desk-clerk-agent",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
};

/** A channel that answers with the outcomes given, one per `send`, and keeps what it was sent. */
function channelOf(...outcomes: readonly (() => Promise<unknown>)[]) {
  const sent: ChannelSenderAsk[] = [];
  const channel: PauseChannel = {
    name: "refund-approval-channel",
    answeredBy: PauseAnswerer.Channel,
    sender: {
      send: (ask) => {
        sent.push(ask);
        const next = outcomes[sent.length - 1];
        return next === undefined ? Promise.reject(new Error("asked too often")) : next();
      },
    },
  };
  return { channel, sent };
}

const siteOf = (pauses: InMemoryPausedExecutionRepository, channel: PauseChannel) => ({
  pauses,
  channel,
  frame: testFrame(),
  signal: undefined,
  onSend: () => Promise.resolve(),
});

describe("#267 S35: the pause step", () => {
  it("a crash between the record and send: the next try asks again with the same pauseId", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { channel, sent } = channelOf(
      () => Promise.reject(new Error("the process died")),
      () => Promise.resolve(ChannelOutcome.decided({ approved: true })),
    );
    const site = siteOf(pauses, channel);

    await expect(pauseStep(site, question)).rejects.toThrow("the process died");
    const answer = await pauseStep(site, question);

    expect(sent).toHaveLength(2);
    expect(sent[0]?.pauseId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[1]?.pauseId).toBe(sent[0]?.pauseId);
    expect(answer).toEqual({ decision: { approved: true }, by: "refund-approval-channel" });
  });

  it("decided(…) forgets the reserved record: nothing waits", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { channel, sent } = channelOf(() =>
      Promise.resolve(ChannelOutcome.decided({ approved: false })),
    );

    await pauseStep(siteOf(pauses, channel), question);

    const frame = testFrame();
    const tree = await pauses.findAllByTenantIdAndRootExecutionId(
      frame.execution.tenant.tenantId,
      frame.execution.executionId,
    );
    expect(tree).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("a reply that resolved the pause while send was returning is taken: no interrupt", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { tenantId } = testFrame().execution.tenant;
    const { channel } = channelOf(async () => {
      const [pause] = await pauses.findAllByTenantIdAndRootExecutionId(
        tenantId,
        testFrame().execution.executionId,
      );
      if (pause === undefined) throw new Error("no record before send");
      const resolution = { decision: { approved: true }, answerer: "manager-17" };
      await pauses.resolveByTenantIdAndPauseId(tenantId, pause.pauseId, resolution);
      return ChannelOutcome.awaitReply();
    });

    const answer = await pauseStep(siteOf(pauses, channel), question);

    expect(answer).toEqual({ decision: { approved: true }, by: "manager-17" });
  });

  it("a withdrawn pause answers nothing: its step stops (its branch was cancelled)", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const frame = testFrame();
    const { channel, sent } = channelOf();
    const made = await pauses.findOrCreateByStepKey({
      pauseId: "withdrawn-pause",
      tenantId: frame.execution.tenant.tenantId,
      threadId: frame.execution.threadId,
      rootExecutionId: frame.execution.executionId,
      executionId: frame.execution.executionId,
      workflow: frame.execution.workflow.name,
      stepKey: frame.step.idempotencyKey,
      nodeId: frame.step.nodeId,
      visitNumber: frame.step.visitNumber,
      itemIndex: undefined,
      agent: question.agent,
      channel: channel.name,
      answeredBy: PauseAnswerer.Channel,
      ask: question.ask,
      status: PauseStatus.Pending,
      isSent: true,
    });
    await pauses.cancelByTenantIdAndPauseId(made.tenantId, made.pauseId);

    await expect(pauseStep(siteOf(pauses, channel), question)).rejects.toBeInstanceOf(
      PauseWithdrawnError,
    );
    expect(sent).toEqual([]);
  });
});
