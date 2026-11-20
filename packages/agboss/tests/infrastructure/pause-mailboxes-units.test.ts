/**
 * #1356 (pauses shard) — the rules of a mailbox as the pure functions they are (#935, #910 I8–I10): when it is live,
 * due, stale or claimed, the head of an append, a token that is or is not its claim, a claim only ever longer, and
 * what a retry and a set-aside make of it.
 */
import { describe, expect, it } from "vitest";
import {
  acknowledgedMailbox,
  appendedMailbox,
  hasUndelivered,
  isClaimedAt,
  isDueAt,
  isHeldBy,
  isLive,
  isStaleAt,
  mailboxKeyOf,
  mailboxOf,
  releasedMailbox,
  renewedMailbox,
  retriedMailbox,
  setAsideMailbox,
  type StoredMailbox,
} from "../../src/infrastructure/pause-mailboxes.js";
import { PauseNoticeKind } from "../../src/infrastructure/pause-notices.js";

const T = (second: number): Date => new Date(second * 1000);
const notice = (seq: number, writtenAt: string) => ({
  seq,
  kind: PauseNoticeKind.Closed,
  writtenAt,
});

const mailbox = (fields: Partial<StoredMailbox> = {}): StoredMailbox => ({
  tenantId: "default",
  pauseId: "p-1",
  recipient: "channel:refund",
  notices: [notice(1, T(5).toISOString()), notice(2, T(6).toISOString())],
  delivered: 0,
  attempts: 0,
  nextAttemptAt: T(10),
  isDead: false,
  headWrittenAt: T(5).toISOString(),
  ...fields,
});

describe("#1356: when a mailbox is live, claimed and due", () => {
  it("is live while it has a notice no receiver acknowledged and is not dead", () => {
    expect(hasUndelivered(mailbox())).toBe(true);
    expect(hasUndelivered(mailbox({ delivered: 2 }))).toBe(false);
    expect(hasUndelivered(mailbox({ delivered: 1 }))).toBe(true);
    expect(isLive(mailbox())).toBe(true);
    expect(isLive(mailbox({ isDead: true }))).toBe(false);
    expect(isLive(mailbox({ delivered: 2 }))).toBe(false);
  });

  it("a claim is held until its end: at the end it is over", () => {
    const claimed = mailbox({ claim: { token: "t", until: T(30) } });

    expect(isClaimedAt(claimed, T(29))).toBe(true);
    expect(isClaimedAt(claimed, T(30))).toBe(false);
    expect(isClaimedAt(claimed, T(31))).toBe(false);
    expect(isClaimedAt(mailbox(), T(0))).toBe(false);
  });

  it("is due when live, at its time or after, and not claimed", () => {
    expect(isDueAt(mailbox(), T(9))).toBe(false);
    expect(isDueAt(mailbox(), T(10))).toBe(true);
    expect(isDueAt(mailbox(), T(11))).toBe(true);
    expect(isDueAt(mailbox({ isDead: true }), T(11))).toBe(false);
    expect(isDueAt(mailbox({ claim: { token: "t", until: T(30) } }), T(11))).toBe(false);
    expect(isDueAt(mailbox({ claim: { token: "t", until: T(30) } }), T(30))).toBe(true);
  });

  it("is stale when live, its head written before the cutoff, and not claimed", () => {
    const cutoff = T(6);

    expect(isStaleAt(mailbox(), cutoff, T(20))).toBe(true);
    expect(isStaleAt(mailbox({ headWrittenAt: T(6).toISOString() }), cutoff, T(20))).toBe(false);
    expect(isStaleAt(mailbox({ headWrittenAt: T(7).toISOString() }), cutoff, T(20))).toBe(false);
    expect(isStaleAt(mailbox({ headWrittenAt: undefined }), cutoff, T(20))).toBe(false);
    expect(isStaleAt(mailbox({ isDead: true }), cutoff, T(20))).toBe(false);
    expect(isStaleAt(mailbox({ delivered: 2 }), cutoff, T(20))).toBe(false);
    expect(isStaleAt(mailbox({ claim: { token: "t", until: T(30) } }), cutoff, T(20))).toBe(false);
    expect(isStaleAt(mailbox({ claim: { token: "t", until: T(20) } }), cutoff, T(20))).toBe(true);
  });
});

describe("#1356: the claim of a mailbox", () => {
  it("is the token it holds: another token, and a mailbox with no claim, are not", () => {
    const claimed = mailbox({ claim: { token: "t", until: T(30) } });

    expect(isHeldBy(claimed, "t")).toBe(true);
    expect(isHeldBy(claimed, "other")).toBe(false);
    expect(isHeldBy(mailbox(), "t")).toBe(false);
    expect(isHeldBy(releasedMailbox(claimed), "t")).toBe(false);
  });

  it("only ever grows: a later end replaces it, an earlier or equal one leaves it as it is, no claim leaves none", () => {
    const claimed = mailbox({ claim: { token: "t", until: T(30) } });

    expect(renewedMailbox(claimed, T(40)).claim).toStrictEqual({ token: "t", until: T(40) });
    expect(renewedMailbox(claimed, T(30))).toBe(claimed);
    expect(renewedMailbox(claimed, T(20))).toBe(claimed);
    const unclaimed = mailbox();
    expect(renewedMailbox(unclaimed, T(40))).toBe(unclaimed);
  });

  it("a mailbox a receiver sees has none of the claim's bookkeeping", () => {
    const seen = mailboxOf(mailbox({ claim: { token: "t", until: T(30) }, problem: "boom" }));

    expect(seen).not.toHaveProperty("claim");
    expect(seen).toMatchObject({ pauseId: "p-1", recipient: "channel:refund", problem: "boom" });
    expect(mailboxKeyOf("a", "b", "c")).toBe('["a","b","c"]');
  });
});

describe("#1356: an append, an acknowledgement, a retry and a set-aside", () => {
  const planned = (second: number) => ({
    recipient: "channel:refund",
    at: T(second),
    notice: { kind: PauseNoticeKind.Closed, writtenAt: T(second).toISOString() },
  });
  const site = { tenantId: "default", pauseId: "p-1" };

  it("an append to a mailbox that is not there makes it, due now, its notice the head", () => {
    const made = appendedMailbox(undefined, site, planned(7));

    expect(made).toMatchObject({
      recipient: "channel:refund",
      delivered: 0,
      attempts: 0,
      nextAttemptAt: T(7),
      isDead: false,
      headWrittenAt: T(7).toISOString(),
    });
    expect(made.notices.map(({ seq }) => seq)).toEqual([1]);
  });

  it("an append to an idle mailbox makes the new notice the head and the mailbox due again, attempts and problem cleared", () => {
    const idle = mailbox({ delivered: 2, attempts: 3, problem: "boom", headWrittenAt: undefined });

    const next = appendedMailbox(idle, site, planned(20));

    expect(next).toMatchObject({
      attempts: 0,
      nextAttemptAt: T(20),
      headWrittenAt: T(20).toISOString(),
    });
    expect(next.problem).toBeUndefined();
    expect(next.notices.map(({ seq }) => seq)).toEqual([1, 2, 3]);
  });

  it("an append behind an undelivered head changes neither the head nor the due time", () => {
    const busy = mailbox({ attempts: 2, problem: "boom" });

    const next = appendedMailbox(busy, site, planned(20));

    expect(next).toMatchObject({ attempts: 2, problem: "boom", nextAttemptAt: T(10) });
    expect(next.headWrittenAt).toBe(T(5).toISOString());
    expect(next.notices.map(({ seq }) => seq)).toEqual([1, 2, 3]);
  });

  it("an acknowledgement makes the next notice the head, due now, and keeps the claim while notices remain", () => {
    const claimed = mailbox({ attempts: 2, problem: "boom", claim: { token: "t", until: T(30) } });

    const acknowledged = acknowledgedMailbox(claimed, T(12));

    expect(acknowledged).toMatchObject({
      delivered: 1,
      attempts: 0,
      nextAttemptAt: T(12),
      headWrittenAt: T(6).toISOString(),
      claim: { token: "t", until: T(30) },
    });
    expect(acknowledged.problem).toBeUndefined();
  });

  it("the last acknowledged leaves no head and releases the claim", () => {
    const last = mailbox({ delivered: 1, claim: { token: "t", until: T(30) } });

    const acknowledged = acknowledgedMailbox(last, T(12));

    expect(acknowledged.delivered).toBe(2);
    expect(acknowledged.headWrittenAt).toBeUndefined();
    expect(acknowledged.claim).toBeUndefined();
  });

  it("a retry counts one more attempt, due when told, its problem kept, the claim released", () => {
    const retried = retriedMailbox(
      mailbox({ attempts: 1, claim: { token: "t", until: T(30) } }),
      T(50),
      "boom",
    );

    expect(retried).toMatchObject({ attempts: 2, nextAttemptAt: T(50), problem: "boom" });
    expect(retried.claim).toBeUndefined();
  });

  it("a set-aside is dead with its problem, the claim released", () => {
    const dead = setAsideMailbox(mailbox({ claim: { token: "t", until: T(30) } }), "boom");

    expect(dead).toMatchObject({ isDead: true, problem: "boom" });
    expect(dead.claim).toBeUndefined();
  });
});
