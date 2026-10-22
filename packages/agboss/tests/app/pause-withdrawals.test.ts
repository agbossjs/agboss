/**
 * #337: telling a channel its pause was withdrawn never fails the caller — an unknown channel or a
 * frame that cannot be rebuilt is a `channel.withdraw-failed` warning; a channel without `withdraw`
 * is not told and nothing is logged.
 */
import { describe, expect, it } from "vitest";
import { pauseWithdrawalsOf, type WithdrawalParts } from "../../src/app/pause-withdrawals.js";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { recordingLog } from "../helpers/log.js";
import { testFrame } from "../helpers/frame.js";

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
  status: PauseStatus.Cancelled,
  isSent: true,
  askedAt: "2026-01-05T09:00:00.000Z",
};
const withdrawn = { pause, resolution: PauseResolution.Cancelled } as const;

/** The parts of an app with one channel (or none), its frames rebuilt by `frameOf`. */
function partsOf(overrides: Partial<WithdrawalParts>) {
  const { log, entries } = recordingLog();
  const parts: WithdrawalParts = {
    channelOf: () => undefined,
    frameOf: () => Promise.resolve(testFrame()),
    timeoutOf: () => seconds(5),
    clock: new VirtualClock(),
    log,
    ...overrides,
  };
  return { parts, entries };
}

describe("#337: a withdrawal is told best-effort", () => {
  it("an unknown channel is a warning, never a throw", async () => {
    const { parts, entries } = partsOf({});

    await pauseWithdrawalsOf(parts)(withdrawn);

    expect(entries).toMatchObject([
      {
        level: "warn",
        code: "channel.withdraw-failed",
        message: expect.stringContaining("unknown channel"),
      },
    ]);
  });

  it("a frame that cannot be rebuilt is a warning; the channel is not told", async () => {
    const told: unknown[] = [];
    const sender = {
      send: (): Promise<unknown> => Promise.resolve(undefined),
      withdraw: (withdrawal: unknown): Promise<void> => {
        told.push(withdrawal);
        return Promise.resolve();
      },
    };
    const { parts, entries } = partsOf({
      channelOf: () => ({
        name: "refund-approval-channel",
        sender,
        answeredBy: PauseAnswerer.Channel,
      }),
      frameOf: () => Promise.reject(new Error("the checkpoint is gone")),
    });

    await pauseWithdrawalsOf(parts)(withdrawn);

    expect(told).toEqual([]);
    expect(entries).toMatchObject([{ message: expect.stringContaining("the checkpoint is gone") }]);
  });

  it("a channel without withdraw is not told, nothing is logged", async () => {
    const sender = { send: (): Promise<unknown> => Promise.resolve(undefined) };
    const { parts, entries } = partsOf({
      channelOf: () => ({
        name: "terminal-user-channel",
        sender,
        answeredBy: PauseAnswerer.ThreadOwner,
      }),
    });

    await pauseWithdrawalsOf(parts)(withdrawn);

    expect(entries).toEqual([]);
  });
});
