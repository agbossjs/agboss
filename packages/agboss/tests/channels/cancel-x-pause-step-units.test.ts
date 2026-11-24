import { usd } from "../../src/units/index.js";
/**
 * #1366 (shard `cancel-x-pauses`): the pause step's answer on its own (`pause.ts`) — a failing `send` is the asking
 * step's unless the pass was stopped, a reply that is no outcome is refused, a re-entry of a sent pause asks
 * nobody and stops at `interrupt()`, a pause that closed without an answer is a withdrawal or an expiry, a
 * resolved one is marked taken before the step acts (never by a stopped pass), a looked-for record only when the
 * deadline is in working time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import {
  PauseKind,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { PauseExpirySignal } from "../../src/flow/runtime/pause-expiry-failure.js";
import {
  ChannelSendError,
  pauseStep,
  PauseWithdrawnError,
  sentBy,
  THREAD_OWNER,
} from "../../src/flow/runtime/pause.js";
import { hours } from "../../src/units/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { testFrame } from "../helpers/frame.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { targetOfChannel, type FlatChannel } from "../helpers/pause-target.js";

const mocks = vi.hoisted(() => ({ interrupt: vi.fn() }));
vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  interrupt: mocks.interrupt,
}));

const question = {
  kind: PauseKind.Approval,
  step: "desk-clerk-agent",
  input: { orderId: "7" },
  toolCall: { callId: "call-1", tool: "refund", summary: "refund 7" },
};

const clock = new VirtualClock();
const frame = testFrame();
const { tenantId } = frame.execution.tenant;

function setup(
  options: { send?: () => Promise<unknown>; signal?: AbortSignal; expiresIn?: number } = {},
) {
  const pauses = new InMemoryPausedExecutionRepository();
  const send = vi.fn(options.send ?? (() => Promise.resolve(ChannelOutcome.awaitReply())));
  const channel: FlatChannel = {
    name: "refund-approval-channel",
    respondent: PauseRespondent.Delegate,
    sender: { send },
    ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn as never }),
  };
  const savePauseAnswer = vi.fn(() => Promise.resolve());
  const delivered = vi.fn();
  const opened = vi.fn();
  const onSend = vi.fn(() => Promise.resolve());
  const site = {
    pauses,
    answers: { savePauseAnswer },
    target: targetOfChannel(channel),
    frame,
    signal: options.signal,
    clock,
    validate: (decision: unknown): unknown => decision,
    onSend,
    notices: {
      recipientsOf: () => NO_RECIPIENTS,
      delivered,
      tally: { opened, closed: vi.fn(), answerNotTaken: vi.fn() },
    },
  } as never;
  return { pauses, send, channel, site, delivered, opened, onSend };
}

/** A stored pause of the step's key, in the state given. */
async function stored(
  pauses: InMemoryPausedExecutionRepository,
  overrides: Partial<PauseRecord> = {},
): Promise<PauseRecord> {
  return pauses.findOrCreateByStepKey({
    pauseId: "pause-1",
    tenantId,
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
    target: "refund-tool-approval",
    channel: "refund-approval-channel",
    respondent: PauseRespondent.Delegate,
    input: question.input,
    toolCall: question.toolCall,
    trail: [],
    status: PauseStatus.Pending,
    isSent: false,
    askedAt: clock.now().toISOString(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1366: a channel's send", () => {
  const channel: FlatChannel = {
    name: "refund-approval-channel",
    respondent: PauseRespondent.Delegate,
    sender: { send: () => Promise.reject(new Error("the channel failed")) },
  };
  const ask = { pauseId: "p-1", input: question.input, trail: [] } as never;

  it("a failure is the asking step's, the channel's error its cause — unless the pass was stopped, when it is the error itself", async () => {
    const failure = await sentBy(channel, ask, undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelSendError);
    expect((failure as Error).message).toBe("channel refund-approval-channel: send() failed");
    expect((failure as Error).cause).toMatchObject({ message: "the channel failed" });
    expect(
      await sentBy(channel, ask, new AbortController().signal).catch((e: unknown) => e),
    ).toBeInstanceOf(ChannelSendError);

    const stop = new AbortController();
    stop.abort();
    const raw = await sentBy(channel, ask, stop.signal).catch((error: unknown) => error);
    expect(raw).not.toBeInstanceOf(ChannelSendError);
    expect((raw as Error).message).toBe("the channel failed");
  });

  it("a reply that is no outcome is refused, naming the channel, and nothing is marked sent", async () => {
    const { site, pauses } = setup({ send: () => Promise.resolve("later") });

    await expect(pauseStep(site, question)).rejects.toThrow(
      new TypeError(
        "channel refund-approval-channel: send() must return ChannelOutcome.awaitReply() or ChannelOutcome.decided(…)",
      ),
    );

    const [pause] = await pauses.findAllByTenantIdAndRootExecutionId(
      tenantId,
      frame.execution.executionId,
    );
    expect(pause?.isSent).toBe(false);
  });
});

describe("#1366: a step that waits", () => {
  it("a new pause: reported once, asked once, marked sent, its notices looked for and its tally told, then the step stops at interrupt() — which holds no answer", async () => {
    const { site, pauses, send, delivered, opened, onSend } = setup();

    await expect(pauseStep(site, question)).rejects.toThrow(
      /^pause [0-9a-f]{32} was resumed without a recorded decision$/,
    );

    const [pause] = await pauses.findAllByTenantIdAndRootExecutionId(
      tenantId,
      frame.execution.executionId,
    );
    expect(onSend).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(pause?.isSent).toBe(true);
    expect(delivered).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ pauseId: pause?.pauseId }));
    expect(mocks.interrupt).toHaveBeenCalledOnce();
    expect(mocks.interrupt).toHaveBeenCalledWith({ pauseId: pause?.pauseId });
  });

  it("a re-entry of a sent pause asks nobody and goes straight to interrupt()", async () => {
    const { site, pauses, send, delivered, onSend } = setup();
    await stored(pauses, { isSent: true });
    const read = vi.spyOn(pauses, "findByTenantIdAndPauseId");

    await expect(pauseStep(site, question)).rejects.toThrow(
      "pause pause-1 was resumed without a recorded decision",
    );

    expect(onSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(mocks.interrupt).toHaveBeenCalledWith({ pauseId: "pause-1" });
  });

  it("a pass that is stopped asks nobody and never reaches interrupt() — before the send, and after it", async () => {
    const stop = new AbortController();
    stop.abort(new Error("the pass was stopped"));
    const before = setup({ signal: stop.signal });
    await expect(pauseStep(before.site, question)).rejects.toThrow("the pass was stopped");
    expect(before.send).not.toHaveBeenCalled();

    const live = new AbortController();
    const after = setup({
      signal: live.signal,
      send: () => {
        live.abort(new Error("stopped while asking"));
        return Promise.resolve(ChannelOutcome.awaitReply());
      },
    });
    await expect(pauseStep(after.site, question)).rejects.toThrow("stopped while asking");
    expect(mocks.interrupt).not.toHaveBeenCalled();
  });

  it("a reply that resolved the pause while send was returning: re-read, the answer taken, no interrupt", async () => {
    const { site, pauses } = setup({
      send: async () => {
        await pauses.resolveByTenantIdAndPauseId(
          tenantId,
          (
            await pauses.findAllByTenantIdAndRootExecutionId(tenantId, frame.execution.executionId)
          )[0]?.pauseId ?? "",
          { decision: { approved: true }, actor: { id: "manager-17" } },
          clock.now(),
          NO_RECIPIENTS,
        );
        return ChannelOutcome.awaitReply();
      },
    });

    expect(await pauseStep(site, question)).toEqual({
      decision: { approved: true },
      by: "manager-17",
      usage: [],
    });
    expect(mocks.interrupt).not.toHaveBeenCalled();
  });
});

describe("#1366: a pause that is no longer pending", () => {
  const answered = { decision: { approved: true }, actor: { id: "manager-17" } };

  it("withdrawn: its step stops with the withdrawal, naming the pause — whether the answer it held is kept or not", async () => {
    for (const answer of [undefined, answered]) {
      const { site, pauses } = setup();
      const made = await stored(pauses, { isSent: true });
      await pauses.cancelByTenantIdAndPauseId(
        tenantId,
        made.pauseId,
        PauseResolution.Withdrawn,
        clock.now(),
        NO_RECIPIENTS,
      );
      if (answer !== undefined)
        vi.spyOn(pauses, "findOrCreateByStepKey").mockResolvedValue({
          ...made,
          status: PauseStatus.Cancelled,
          resolution: PauseResolution.Withdrawn,
          answer,
        });

      const thrown = await pauseStep(site, question).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(PauseWithdrawnError);
      expect((thrown as Error).message).toBe(
        "pause pause-1 was withdrawn: its branch was cancelled",
      );
    }
  });

  it("closed by its expiry: the step gets the expiry's signal, not a withdrawal", async () => {
    const { site, pauses } = setup();
    const made = await stored(pauses, { isSent: true });
    vi.spyOn(pauses, "findOrCreateByStepKey").mockResolvedValue({
      ...made,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
    });

    const thrown = await pauseStep(site, question).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PauseExpirySignal);
  });

  it("taken with no answer on record (a store's own state): a withdrawal, never an answer made up", async () => {
    const { site, pauses } = setup();
    const made = await stored(pauses, { isSent: true });
    vi.spyOn(pauses, "findOrCreateByStepKey").mockResolvedValue({
      ...made,
      status: PauseStatus.Taken,
    });

    await expect(pauseStep(site, question)).rejects.toBeInstanceOf(PauseWithdrawnError);
  });

  it("an answer no step took yet: marked taken, durably, before the step acts; who answered, or the thread's owner, and what reading it cost", async () => {
    for (const [answer, by] of [
      [{ ...answered, usage: [{ costUsd: usd(1) }] }, "manager-17"],
      [{ decision: { approved: true }, actor: undefined }, THREAD_OWNER],
    ] as const) {
      const { site, pauses } = setup();
      const made = await stored(pauses, { isSent: true });
      await pauses.resolveByTenantIdAndPauseId(
        tenantId,
        made.pauseId,
        answer as never,
        clock.now(),
        NO_RECIPIENTS,
      );
      const mark = vi.spyOn(pauses, "markTakenByTenantIdAndPauseId");

      const result = await pauseStep(site, question);

      expect(result).toEqual({
        decision: { approved: true },
        by,
        usage: "usage" in answer ? answer.usage : [],
      });
      expect(mark).toHaveBeenCalledWith(tenantId, "pause-1");
    }
  });

  it("a pass that was stopped does not take the answer: nothing is marked", async () => {
    const stop = new AbortController();
    stop.abort(new Error("the pass was stopped"));
    const { site, pauses } = setup({ signal: stop.signal });
    const made = await stored(pauses, { isSent: true });
    await pauses.resolveByTenantIdAndPauseId(
      tenantId,
      made.pauseId,
      answered,
      clock.now(),
      NO_RECIPIENTS,
    );
    const mark = vi.spyOn(pauses, "markTakenByTenantIdAndPauseId");

    // the stopped pass is refused before a pending check, like every step of it
    const resolved = await pauseStep(site, question).catch((error: unknown) => error);

    expect((resolved as Error).message).toBe("the pass was stopped");
    expect(mark).not.toHaveBeenCalled();
  });

  it("an answer a step took already (a re-entry): given again, not marked again", async () => {
    const { site, pauses } = setup();
    const made = await stored(pauses, { isSent: true });
    await pauses.resolveByTenantIdAndPauseId(
      tenantId,
      made.pauseId,
      answered,
      clock.now(),
      NO_RECIPIENTS,
    );
    await pauses.markTakenByTenantIdAndPauseId(tenantId, made.pauseId);
    const mark = vi.spyOn(pauses, "markTakenByTenantIdAndPauseId");

    expect(await pauseStep(site, question)).toEqual({
      decision: { approved: true },
      by: "manager-17",
      usage: [],
    });
    expect(mark).not.toHaveBeenCalled();
  });

  it.each([PauseResolution.Decided, PauseResolution.DecidedOnExpiry])(
    "the channel decided (%s): its decision, the channel its respondent, its spend counted already",
    async (resolution) => {
      const { site, pauses } = setup();
      const made = await stored(pauses, { isSent: true });
      vi.spyOn(pauses, "findOrCreateByStepKey").mockResolvedValue({
        ...made,
        status: PauseStatus.Taken,
        resolution,
        answer: {
          decision: { approved: false },
          actor: undefined,
          usage: [{ costUsd: usd(5) }],
        } as never,
      });

      expect(await pauseStep(site, question)).toEqual({
        decision: { approved: false },
        by: "refund-approval-channel",
        usage: [],
      });
    },
  );
});

describe("#1366: the record of a step's pause", () => {
  it("with a deadline in working time the record is looked for first, and never made again; with none or a plain one it is not looked for", async () => {
    const plain = setup({ expiresIn: hours(1) });
    const lookedFor = vi.spyOn(plain.pauses, "findByTenantIdAndRootExecutionIdAndStepKey");
    await pauseStep(plain.site, question).catch(() => undefined);
    expect(lookedFor).not.toHaveBeenCalled();

    const none = setup();
    const lookedForNone = vi.spyOn(none.pauses, "findByTenantIdAndRootExecutionIdAndStepKey");
    await pauseStep(none.site, question).catch(() => undefined);
    expect(lookedForNone).not.toHaveBeenCalled();
  });
});
