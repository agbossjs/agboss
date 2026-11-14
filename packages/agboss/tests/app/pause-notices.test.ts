/**
 * #940: what a receiver is told of a pause — built from the notice and the record. The channel gets
 * the question as `send` got it and the answer masked; a listener gets the safe context, the
 * question and the answer masked, and the answering id only when it may answer; the `deliveryId`
 * is a function of the pause, the receiver and the notice's place — nothing else (I8, I15).
 */
import { describe, expect, it } from "vitest";
import {
  channelClosedOf,
  channelNotTakenOf,
  deliveryIdOf,
  listenerClosedOf,
  listenerNotTakenOf,
  listenerOpenedOf,
  listensTo,
  recipientsOf,
} from "../../src/app/pause-notices.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import {
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
  pauseKeyOf,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { PauseNoticeKind, type PauseNotice } from "../../src/infrastructure/pause-notices.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const answered: PauseRecord = {
  ...pauseOf("p-1"),
  status: PauseStatus.Resolved,
  isSent: true,
  resolution: PauseResolution.Replied,
  answer: { decision: { approved: true, mail: "alice@example.com" }, answeredBy: "manager-17" },
};

const closed: PauseNotice = {
  seq: 2,
  kind: PauseNoticeKind.Closed,
  writtenAt: "2026-01-05T10:00:00.000Z",
  reason: PauseClosedReason.Answered,
  closedAt: "2026-01-05T10:00:00.000Z",
};

/** A mask that hides every email, like the observability policies' detectors. */
const mask = (value: unknown): Promise<unknown> =>
  Promise.resolve(JSON.parse(JSON.stringify(value).replaceAll("alice@example.com", "<email>")));

const sources = (pause: PauseRecord, notice: PauseNotice) => ({
  pause,
  notice,
  deliveryId: deliveryIdOf(pause, "listener:ledger-pause-listener", notice),
  masked: mask,
});

describe("#940: the events a receiver is told", () => {
  it("AC1: a channel hears answered with who answered and the masked answer, and the question as send got it", async () => {
    const event = await channelClosedOf(sources(answered, closed));

    expect(event).toMatchObject({
      pauseId: "p-1",
      value: answered.ask,
      reason: PauseClosedReason.Answered,
      closedAt: "2026-01-05T10:00:00.000Z",
      answeredBy: "manager-17",
      answer: { approved: true, mail: "<email>" },
    });
  });

  it("a close that is no answer carries neither answer nor answeredBy", async () => {
    const cancelled = { ...closed, reason: PauseClosedReason.Cancelled };

    const event = await channelClosedOf(sources({ ...answered, answer: undefined }, cancelled));

    expect(event).not.toHaveProperty("answer");
    expect(event).not.toHaveProperty("answeredBy");
  });

  it("Q2: an answer never applied: its reason, when, who had answered and the masked answer", async () => {
    const untaken = {
      ...closed,
      kind: PauseNoticeKind.AnswerNotTaken,
      reason: PauseClosedReason.TreeEnded,
    };

    expect(await channelNotTakenOf(sources(answered, untaken))).toMatchObject({
      reason: PauseClosedReason.TreeEnded,
      at: "2026-01-05T10:00:00.000Z",
      answeredBy: "manager-17",
      answer: { mail: "<email>" },
    });
    expect(await listenerNotTakenOf(sources(answered, untaken), false)).toMatchObject({
      reason: PauseClosedReason.TreeEnded,
      answer: { mail: "<email>" },
    });
  });

  it("AC5: a listener hears the masked question and answer, a pauseKey, no raw id of a channel pause", async () => {
    const opened = await listenerOpenedOf(
      sources(
        {
          ...answered,
          ask: { callId: "c", tool: "t", arguments: { to: "alice@example.com" }, summary: "s" },
        },
        closed,
      ),
      false,
    );
    const event = await listenerClosedOf(sources(answered, closed), false);

    expect(JSON.stringify(opened.ask)).not.toContain("alice@example.com");
    expect(event).not.toHaveProperty("pauseId");
    expect(event).toMatchObject({
      pauseKey: pauseKeyOf("default", "p-1"),
      answeredBy: "manager-17",
      answer: { mail: "<email>" },
    });
  });

  it("AC5: allowAnswering, or a thread owner's pause: the raw id", async () => {
    const trusted = await listenerClosedOf(sources(answered, closed), true);
    const owned = { ...answered, answerer: PauseAnswerer.ThreadOwner };
    const byOwner = await listenerClosedOf(sources(owned, closed), false);

    expect(trusted).toMatchObject({ pauseId: "p-1" });
    expect(byOwner).toMatchObject({ pauseId: "p-1" });
  });

  it("AC5: the deliveryId depends on the pause, the receiver and the notice's place only", () => {
    const first = deliveryIdOf(answered, "listener:a-pause-listener", closed);

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(
      deliveryIdOf(answered, "listener:a-pause-listener", { ...closed, writtenAt: "later" }),
    ).toBe(first);
    expect(deliveryIdOf(answered, "listener:b-pause-listener", closed)).not.toBe(first);
    expect(deliveryIdOf(answered, "listener:a-pause-listener", { ...closed, seq: 3 })).not.toBe(
      first,
    );
    expect(
      deliveryIdOf({ ...answered, pauseId: "p-2" }, "listener:a-pause-listener", closed),
    ).not.toBe(first);
  });
});

describe("#940: who hears of a pause", () => {
  class Silent extends ChannelOf<Silent> {
    send = (): Promise<ChannelOutcome<Silent>> => Promise.resolve(ChannelOutcome.awaitReply());
  }
  class Closing extends Silent {
    override onPauseClosed(): Promise<void> {
      return Promise.resolve();
    }
  }
  class NotTaking extends Silent {
    override onPauseAnswerNotTaken(): Promise<void> {
      return Promise.resolve();
    }
  }

  it("AC2: a channel without any hook override has no mailbox; one overriding any hook has", () => {
    expect(listensTo(new Silent())).toBe(false);
    expect(listensTo(new Closing())).toBe(true);
    expect(listensTo(new NotTaking())).toBe(true);
    expect(listensTo(undefined)).toBe(false);
    // a concrete channel that is no `ChannelOf`: the hook is a function
    expect(
      listensTo({ send: () => Promise.resolve(undefined), onPauseClosed: () => Promise.resolve() }),
    ).toBe(true);
  });

  it("every listener, and the channel only when it listens", () => {
    const pause = pauseOf("p-1");
    const of = (sender: ChannelOf<unknown> | undefined) =>
      recipientsOf({ senderOf: () => sender, listeners: ["a-pause-listener"] })(pause);

    expect(of(new Silent())).toEqual({ listeners: ["a-pause-listener"] });
    expect(of(new Closing())).toEqual({ channel: pause.channel, listeners: ["a-pause-listener"] });
    expect(of(undefined)).toEqual({ listeners: ["a-pause-listener"] });
  });
});
