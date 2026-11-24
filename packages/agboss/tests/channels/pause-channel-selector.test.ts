/**
 * #1307: a target with several channels asks its `@ChannelSelector` once, when the pause is made;
 * the record names the target and the channel chosen, a re-entry reads them back and never asks the
 * selector (or the channel) again, and a selector that fails or names a class that serves no channel
 * of the target makes no pause at all (fail closed).
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import type { PauseChannel, PauseTarget } from "../../src/flow/runtime/pause-channel.js";
import { ChannelSelectError, pauseStep } from "../../src/flow/runtime/pause.js";
import { PauseKind } from "../../src/infrastructure/pause-record.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { hours } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";

class SmallChannel {
  readonly mark = "small";
}
class LargeChannel {
  readonly mark = "large";
}
class Stranger {
  readonly mark = "stranger";
}

const clock = new VirtualClock();
const answers = {
  savePauseAnswer: (): Promise<void> => Promise.resolve(),
  markPauseAnswerNotTaken: (): Promise<void> => Promise.resolve(),
  findPauseAnswersByTenantIdAndRootExecutionId: (): Promise<[]> => Promise.resolve([]),
};
const question = {
  kind: PauseKind.Approval,
  step: "desk-clerk-agent",
  input: { orderId: "big-7" },
  toolCall: { callId: "call-1", tool: "refund", summary: "refund 7" },
};

/** A target with a small and a large channel; what each was sent is kept. */
function targetWith(select: PauseTarget["select"]) {
  const sent: { readonly channel: string; readonly pauseId: string }[] = [];
  const channelOf = (name: string, cls: PauseChannel["cls"]): PauseChannel => ({
    name,
    cls,
    sender: {
      send: (ask) => {
        sent.push({ channel: name, pauseId: ask.pauseId });
        return Promise.resolve(ChannelOutcome.awaitReply());
      },
    },
  });
  const channels = new Map([
    ["small-channel", channelOf("small-channel", SmallChannel)],
    ["large-channel", channelOf("large-channel", LargeChannel)],
  ]);
  const target: PauseTarget = {
    name: "refund-tool-approval",
    cls: Stranger,
    kind: "tool-approval",
    respondent: PauseRespondent.Delegate,
    channels,
    select,
    timeout: hours(1),
  };
  return { target, sent };
}

const siteOf = (pauses: InMemoryPausedExecutionRepository, target: PauseTarget) => ({
  pauses,
  answers,
  target,
  frame: testFrame(),
  signal: undefined,
  clock,
  validate: (decision: unknown): unknown => decision,
  onSend: () => Promise.resolve(),
});

/** The first entry stops at its interrupt: outside a graph it throws. */
const enter = (pauses: InMemoryPausedExecutionRepository, target: PauseTarget) =>
  pauseStep(siteOf(pauses, target), question).catch((error: unknown) => error);

const recordsOf = (pauses: InMemoryPausedExecutionRepository) =>
  pauses.findAllByTenantIdAndRootExecutionId("default", testFrame().execution.executionId);

describe("#1307: the channel of a pause is chosen when it is made", () => {
  it("the selector picks the large channel: the record names the target and that channel, only it is sent", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const contexts: unknown[] = [];
    const { target, sent } = targetWith((ctx) => {
      contexts.push(ctx);
      return Promise.resolve(LargeChannel);
    });

    await enter(pauses, target);

    const [pause] = await recordsOf(pauses);
    expect(pause).toMatchObject({
      target: "refund-tool-approval",
      channel: "large-channel",
      trail: [{ action: "opened", target: "refund-tool-approval" }],
    });
    expect(sent).toEqual([{ channel: "large-channel", pauseId: pause?.pauseId }]);
    // the selector read what the pause asks and when it expires
    expect(contexts).toMatchObject([
      { input: { orderId: "big-7" }, toolCall: { tool: "refund" }, trail: [{ action: "opened" }] },
    ]);
  });

  it("a re-entry reads the channel from the record: the selector is not asked again, the channel not sent twice", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    let asked = 0;
    const { target, sent } = targetWith(() => {
      asked += 1;
      return Promise.resolve(SmallChannel);
    });

    await enter(pauses, target);
    await enter(pauses, target);

    expect(asked).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await recordsOf(pauses)).toHaveLength(1);
  });

  it("a selector that throws makes no pause: nothing is recorded, nothing sent", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { target, sent } = targetWith(() =>
      Promise.reject(new Error("the routing table is down")),
    );

    const failed = await enter(pauses, target);

    expect(failed).toBeInstanceOf(ChannelSelectError);
    expect((failed as Error).message).toBe(
      "pause target refund-tool-approval: its @ChannelSelector failed",
    );
    expect(await recordsOf(pauses)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a selector that names a class serving no channel of the target makes no pause", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { target, sent } = targetWith(() => Promise.resolve(Stranger));

    const failed = await enter(pauses, target);

    expect(failed).toBeInstanceOf(ChannelSelectError);
    expect(await recordsOf(pauses)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("several channels and no selector fail closed", async () => {
    const pauses = new InMemoryPausedExecutionRepository();
    const { target } = targetWith(undefined);

    const failed = await enter(pauses, target);

    expect(failed).toBeInstanceOf(ChannelSelectError);
    expect(await recordsOf(pauses)).toEqual([]);
  });
});
