/**
 * #941 (D9, I18): the deadline of a pause is fixed when its record is made — the smaller of its
 * `expiresIn` (the step's or tool's over the role's) and its run's deadline, a tie going to the run
 * (D8) — and a re-entry finds the record as made, so a deploy that changes `expiresIn` never moves
 * an open pause. A step whose pause expired fails with the signal the asking site turns into the
 * step's error.
 */
import { describe, expect, it } from "vitest";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import {
  PauseExpiryBound,
  PauseKind,
  PauseResolution,
  PauseStatus,
} from "../../src/infrastructure/pause-record.js";
import { PauseExpirySignal } from "../../src/flow/runtime/pause-expiry-failure.js";
import { deadlineOf } from "../../src/flow/runtime/pause-record-made.js";
import { pauseStep, type PauseChannel } from "../../src/flow/runtime/pause.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, minutes } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const at = (delay: number): string => new Date(NOW.getTime() + delay).toISOString();
const frameWith = (deadline: number | undefined) => {
  const frame = testFrame();
  return deadline === undefined
    ? frame
    : {
        ...frame,
        execution: {
          ...frame.execution,
          deadline: { at: at(deadline), deadline: deadline as never },
        },
      };
};

describe("#941 D9, I18: the deadline fields of a new record", () => {
  it("none: no deadline", () => {
    expect(deadlineOf(frameWith(undefined), undefined, NOW)).toEqual({});
  });

  it("only expiresIn: its own deadline, bound Pause", () => {
    expect(deadlineOf(frameWith(undefined), hours(24), NOW)).toEqual({
      expiresAt: at(hours(24)),
      expiryBound: PauseExpiryBound.Pause,
    });
  });

  it("only the run's: bound RunDeadline, boundAt the run's", () => {
    expect(deadlineOf(frameWith(minutes(5)), undefined, NOW)).toEqual({
      expiresAt: at(minutes(5)),
      expiryBound: PauseExpiryBound.RunDeadline,
      boundAt: at(minutes(5)),
    });
  });

  it("both: the smaller wins; a tie goes to the run", () => {
    expect(deadlineOf(frameWith(minutes(5)), hours(24), NOW)).toMatchObject({
      expiresAt: at(minutes(5)),
      expiryBound: PauseExpiryBound.RunDeadline,
    });
    expect(deadlineOf(frameWith(hours(48)), hours(24), NOW)).toMatchObject({
      expiresAt: at(hours(24)),
      expiryBound: PauseExpiryBound.Pause,
      boundAt: at(hours(48)),
    });
    expect(deadlineOf(frameWith(hours(24)), hours(24), NOW)).toMatchObject({
      expiryBound: PauseExpiryBound.RunDeadline,
    });
  });

  it("a run deadline already gone: the pause is still made, due at once (the first look expires it)", () => {
    expect(deadlineOf(frameWith(0 - minutes(1)), undefined, NOW)).toMatchObject({
      expiresAt: at(0 - minutes(1)),
      expiryBound: PauseExpiryBound.RunDeadline,
    });
  });
});

describe("#941 D9: a re-entry finds the record as made", () => {
  const clock = new VirtualClock();
  const question = {
    kind: PauseKind.Approval,
    step: "desk-clerk-agent",
    ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
  };
  const channelWith = (expiresIn: number): PauseChannel => ({
    name: "refund-approval-channel",
    answerer: PauseAnswerer.Channel,
    expiresIn: expiresIn as never,
    sender: { send: () => Promise.resolve(ChannelOutcome.awaitReply()) },
  });
  const answers = {
    savePauseAnswer: (): Promise<void> => Promise.resolve(),
    markPauseAnswerNotTaken: (): Promise<void> => Promise.resolve(),
    findPauseAnswersByTenantIdAndRootExecutionId: () => Promise.resolve([]),
  };
  const siteOf = (pauses: InMemoryPausedExecutionRepository, expiresIn: number) => ({
    pauses,
    answers,
    channel: channelWith(expiresIn),
    frame: testFrame(),
    signal: undefined,
    clock,
    validate: (decision: unknown): unknown => decision,
    onSend: () => Promise.resolve(),
  });

  it("a deploy changing expiresIn from 24 h to 1 h leaves the open pause's deadline", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    // the first entry stops at its interrupt: outside a graph it throws
    await pauseStep(siteOf(pauses, hours(24)), question).catch(() => undefined);
    const [first] = await pauses.findAllByTenantIdAndRootExecutionId(
      "default",
      testFrame().execution.executionId,
    );

    await pauseStep(siteOf(pauses, hours(1)), question).catch(() => undefined);
    const [again] = await pauses.findAllByTenantIdAndRootExecutionId(
      "default",
      testFrame().execution.executionId,
    );

    expect(first?.expiresAt).toBe(new Date(clock.now().getTime() + hours(24)).toISOString());
    expect(again?.expiresAt).toBe(first?.expiresAt);
    expect(again?.pauseId).toBe(first?.pauseId);
  });

  it("a pause closed by its expiry without an answer is the asking step's failure signal", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const site = siteOf(pauses, hours(1));
    await pauseStep(site, question).catch(() => undefined);
    const [pause] = await pauses.findAllByTenantIdAndRootExecutionId(
      "default",
      testFrame().execution.executionId,
    );
    await pauses.expireByTenantIdAndPauseId(
      pause?.tenantId ?? "",
      pause?.pauseId ?? "",
      {},
      new Date(clock.now().getTime() + hours(2)),
      { listeners: [] },
    );

    const failed: unknown = await pauseStep(site, question).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(PauseExpirySignal);
    expect(failed).toMatchObject({
      pause: { status: PauseStatus.Cancelled, resolution: PauseResolution.Expired },
    });
  });

  it("a pause the channel decided on expiry gives its decision, by the channel's name", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const site = siteOf(pauses, hours(1));
    await pauseStep(site, question).catch(() => undefined);
    const [pause] = await pauses.findAllByTenantIdAndRootExecutionId(
      "default",
      testFrame().execution.executionId,
    );
    await pauses.expireByTenantIdAndPauseId(
      pause?.tenantId ?? "",
      pause?.pauseId ?? "",
      { answer: { decision: { approved: true }, answeredBy: undefined } },
      new Date(clock.now().getTime() + hours(2)),
      { listeners: [] },
    );

    const answer = await pauseStep(site, question);

    expect(answer).toEqual({
      decision: { approved: true },
      by: "refund-approval-channel",
      usage: [],
    });
  });
});
