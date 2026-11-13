/**
 * #267 AC3 / S35 — the pause step on its own: a pause is recorded by its step's key before its
 * channel is asked, with a random 128-bit `pauseId` made once; a step tried again after a crash
 * between the record and `send` asks again with the same `pauseId`; a reply that resolved the pause
 * while `send` was still returning is taken at once; `decided(…)` closes the record at once (`Taken`,
 * `PauseResolution.Decided`, #267 S107) — nothing waits, a re-entry asks nobody. Through the
 * application: `tests/channels/parallel-pauses.test.ts` (no second `send` on re-entry) and
 * `tests/channels/concurrent-resume.test.ts`.
 */
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import { describe, expect, it } from "vitest";
import type { PauseAnswerRecord } from "../../src/flow/runtime/execution-record.js";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import type { ChannelSenderAsk } from "../../src/channels/channel-sender.js";
import { PauseKind, PauseResolution, PauseStatus } from "../../src/infrastructure/pause-record.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import {
  ChannelSendError,
  pauseStep,
  PauseWithdrawnError,
  type PauseChannel,
} from "../../src/flow/runtime/pause.js";
import { testFrame } from "../helpers/frame.js";
import { closeTreePauses } from "../../src/app/tree-end-pauses.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import type { WithdrawnPause } from "../../src/pause/index.js";

const question = {
  kind: PauseKind.Approval,
  step: "desk-clerk-agent",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
};

/** A channel that answers with the outcomes given, one per `send`, and keeps what it was sent. */
function channelOf(...outcomes: readonly (() => Promise<unknown>)[]) {
  const sent: ChannelSenderAsk[] = [];
  const channel: PauseChannel = {
    name: "refund-approval-channel",
    answerer: PauseAnswerer.Channel,
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

const clock = new VirtualClock();

/** The pause answer log: nothing to check here (the records are tested through the app). */
const answers = {
  savePauseAnswer: (): Promise<void> => Promise.resolve(),
  markPauseAnswerNotTaken: (): Promise<void> => Promise.resolve(),
  findPauseAnswersByTenantIdAndRootExecutionId: (): Promise<PauseAnswerRecord[]> =>
    Promise.resolve([]),
};

const siteOf = (pauses: InMemoryPausedExecutionRepository, channel: PauseChannel) => ({
  pauses,
  answers,
  channel,
  frame: testFrame(),
  signal: undefined,
  clock,
  validate: (decision: unknown): unknown => decision,
  onSend: () => Promise.resolve(),
});

describe("#267 S35: the pause step", () => {
  it("a crash between the record and send: the next try asks again with the same pauseId", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const died = new Error("the process died");
    const { channel, sent } = channelOf(
      () => Promise.reject(died),
      () => Promise.resolve(ChannelOutcome.decided({ approved: true })),
    );
    const site = siteOf(pauses, channel);

    // the channel's failure is the asking step's, its error kept as the cause
    const failed: unknown = await pauseStep(site, question).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ChannelSendError);
    expect(failed).toHaveProperty("cause", died);
    const answer = await pauseStep(site, question);

    expect(sent).toHaveLength(2);
    expect(sent[0]?.pauseId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[1]?.pauseId).toBe(sent[0]?.pauseId);
    expect(answer).toEqual({
      decision: { approved: true },
      by: "refund-approval-channel",
      usage: [],
    });
  });

  it("decided(…) closes the reserved record at once: nothing waits, a re-entry asks nobody", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { channel, sent } = channelOf(() =>
      Promise.resolve(ChannelOutcome.decided({ approved: false })),
    );

    await pauseStep(siteOf(pauses, channel), question);
    const again = await pauseStep(siteOf(pauses, channel), question);

    const frame = testFrame();
    const tree = await pauses.findAllByTenantIdAndRootExecutionId(
      frame.execution.tenant.tenantId,
      frame.execution.executionId,
    );
    expect(tree).toMatchObject([
      {
        status: PauseStatus.Taken,
        resolution: PauseResolution.Decided,
        answer: { decision: { approved: false }, answeredBy: undefined },
        askedAt: "2026-01-05T09:00:00.000Z",
        resolvedAt: "2026-01-05T09:00:00.000Z",
      },
    ]);
    expect(again).toEqual({
      decision: { approved: false },
      by: "refund-approval-channel",
      usage: [],
    });
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
      const answer = { decision: { approved: true }, answeredBy: "manager-17" };
      await pauses.resolveByTenantIdAndPauseId(
        tenantId,
        pause.pauseId,
        answer,
        clock.now(),
        NO_RECIPIENTS,
      );
      return ChannelOutcome.awaitReply();
    });

    const answer = await pauseStep(siteOf(pauses, channel), question);

    expect(answer).toEqual({ decision: { approved: true }, by: "manager-17", usage: [] });
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
      copyNumber: 1,
      kind: question.kind,
      step: question.step,
      channel: channel.name,
      answerer: PauseAnswerer.Channel,
      ask: question.ask,
      status: PauseStatus.Pending,
      isSent: true,
      askedAt: clock.now().toISOString(),
    });
    await pauses.cancelByTenantIdAndPauseId(
      made.tenantId,
      made.pauseId,
      PauseResolution.Withdrawn,
      clock.now(),
      NO_RECIPIENTS,
    );

    await expect(pauseStep(siteOf(pauses, channel), question)).rejects.toBeInstanceOf(
      PauseWithdrawnError,
    );
    expect(sent).toEqual([]);
  });
});

describe("#337: a channel told about its withdrawn pause", () => {
  it("not for a pause its channel decided at once: the tree's end withdraws nothing", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { channel } = channelOf(() =>
      Promise.resolve(ChannelOutcome.decided({ approved: true })),
    );
    const told: unknown[] = [];
    const withdrawn = (withdrawal: unknown): Promise<void> => {
      told.push(withdrawal);
      return Promise.resolve();
    };
    await pauseStep({ ...siteOf(pauses, channel), withdrawn }, question);
    const { execution } = testFrame();
    const site = {
      tenantId: execution.tenant.tenantId,
      threadId: execution.threadId,
      rootExecutionId: execution.executionId,
    };
    const ends = {
      stores: { pauses, answers, withdrawn },
      waiting: () => Promise.resolve(new Set<string>()),
    };

    await closeTreePauses(ends, site, { cause: new ExecutionCancelledError() }, clock.now());

    expect(told).toEqual([]);
  });

  it("a pause withdrawn while send was returning: the step tells the channel, in its frame", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const frame = testFrame();
    const { channel } = channelOf(async () => {
      const [pause] = await pauses.findAllByTenantIdAndRootExecutionId(
        frame.execution.tenant.tenantId,
        frame.execution.executionId,
      );
      await pauses.cancelByTenantIdAndPauseId(
        frame.execution.tenant.tenantId,
        pause?.pauseId ?? "",
        PauseResolution.Withdrawn,
        clock.now(),
        NO_RECIPIENTS,
      );
      return ChannelOutcome.awaitReply();
    });
    const told: WithdrawnPause[] = [];
    const withdrawn = (withdrawal: WithdrawnPause): Promise<void> => {
      told.push(withdrawal);
      return Promise.resolve();
    };

    await expect(
      pauseStep({ ...siteOf(pauses, channel), frame, withdrawn }, question),
    ).rejects.toBeInstanceOf(PauseWithdrawnError);

    expect(told).toMatchObject([
      { resolution: PauseResolution.Withdrawn, frame, pause: { status: PauseStatus.Cancelled } },
    ]);
  });

  it("#939: an aborted pass does not take the answer: the pause stays Resolved; a live pass takes it, Taken", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { channel } = channelOf(() => Promise.resolve(ChannelOutcome.awaitReply()));
    // the first pass sends and stops at its interrupt (outside a graph, a throw is all it can do)
    await pauseStep(siteOf(pauses, channel), question).catch(() => undefined);
    const { execution } = testFrame();
    const { tenantId } = execution.tenant;
    const rootExecutionId = execution.executionId;
    const [waiting] = await pauses.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId);
    if (waiting === undefined) throw new Error("the pause was not recorded");
    await pauses.resolveByTenantIdAndPauseId(
      tenantId,
      waiting.pauseId,
      { decision: { approved: true }, answeredBy: "manager-17" },
      clock.now(),
      NO_RECIPIENTS,
    );
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      pauseStep({ ...siteOf(pauses, channel), signal: aborted.signal }, question),
    ).rejects.toBeDefined();
    expect((await pauses.findByTenantIdAndPauseId(tenantId, waiting.pauseId))?.status).toBe(
      PauseStatus.Resolved,
    );

    const taken = await pauseStep(siteOf(pauses, channel), question);

    expect(taken.decision).toEqual({ approved: true });
    expect((await pauses.findByTenantIdAndPauseId(tenantId, waiting.pauseId))?.status).toBe(
      PauseStatus.Taken,
    );
  });
});
