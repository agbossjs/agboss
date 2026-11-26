/**
 * #1356 (pauses shard), #1307: `reassignChange` as the pure function it is — what an in-place
 * reassignment and a replacement make of the record, its chain of custody and its notices, field by
 * field (a store, or a mutant, that drops one fails here), and when they apply.
 */
import { describe, expect, it } from "vitest";
import { PauseNoticeKind, type PauseRecipients } from "../../src/infrastructure/pause-notices.js";
import { reassignChange } from "../../src/infrastructure/pause-reassign-transition.js";
import {
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { seenOf } from "../../src/infrastructure/pause-seen.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const T9 = "2026-11-20T09:00:00.000Z";
const T10 = "2026-11-20T10:00:00.000Z";
const T11 = "2026-11-20T11:00:00.000Z";
const T12 = "2026-11-20T12:00:00.000Z";
const AT = new Date(T10);
const RECIPIENTS = { channel: "refund", listeners: ["metrics"] };
const actor = { id: "ops-1", orgId: "hq" };

const sentPause = (fields: Partial<PauseRecord> = {}): PauseRecord => ({
  ...pauseOf("p-1"),
  isSent: true,
  channel: "refund",
  assignees: ["clerk"],
  externalRef: "JIRA-1",
  expiresAt: T11,
  expiryBound: PauseExpiryBound.Quorum,
  remindAt: T10,
  ...fields,
});

const inPlace = (pause: PauseRecord, change: object, recipients: PauseRecipients = RECIPIENTS) =>
  reassignChange(pause, { ...change, seen: seenOf(pause) }, new Set(), AT, recipients);

describe("an in-place reassignment", () => {
  it("replaces the assignees and sets the deadline, bound and reminder it names, dropping the old ones", () => {
    const pause = sentPause();
    const done = inPlace(pause, {
      assignees: ["deputy"],
      timeout: { expiresAt: T12, expiryBound: PauseExpiryBound.Pause },
    });

    expect(done?.pause).toMatchObject({
      assignees: ["deputy"],
      expiresAt: T12,
      expiryBound: PauseExpiryBound.Pause,
      externalRef: "JIRA-1",
    });
    expect(done?.pause).not.toHaveProperty("remindAt");
  });

  it("takes away what a deadline it sets leaves out: none at all, or a bound it does not name", () => {
    const none = inPlace(sentPause(), { timeout: {} });
    const unbound = inPlace(sentPause(), { timeout: { expiresAt: T12 } });

    expect(none?.pause).not.toHaveProperty("expiresAt");
    expect(none?.pause).not.toHaveProperty("expiryBound");
    expect(none?.pause).not.toHaveProperty("remindAt");
    expect(unbound?.pause).toMatchObject({ expiresAt: T12 });
    expect(unbound?.pause).not.toHaveProperty("expiryBound");
    expect(unbound?.pause).not.toHaveProperty("remindAt");
  });

  it("keeps the deadline, bound and reminder when it sets none, and releases the pool when it names none", () => {
    const done = inPlace(sentPause(), {});

    expect(done?.pause).toMatchObject({
      expiresAt: T11,
      expiryBound: PauseExpiryBound.Quorum,
      remindAt: T10,
    });
    expect(done?.pause).not.toHaveProperty("assignees");
  });

  it("writes one `reassigned` entry: who, when, to whom, under which deadline, why, with the channel's reference", () => {
    const done = inPlace(sentPause(), {
      assignees: ["deputy"],
      actor,
      reason: "on leave",
      timeout: { expiresAt: T12 },
    });

    expect(done?.pause.trail.at(-1)).toStrictEqual({
      action: "reassigned",
      at: T10,
      actor,
      target: "refund-tool-approval",
      channel: "refund",
      assignees: ["deputy"],
      expiresAt: T12,
      externalRef: "JIRA-1",
      reason: "on leave",
    });
    expect(done?.pause.trail).toHaveLength(2);
  });

  it("leaves out of its entry what the pause or the call does not have", () => {
    const bare = sentPause({ channel: undefined, externalRef: undefined, expiresAt: undefined });
    const done = inPlace(bare, {});

    expect(done?.pause.trail.at(-1)).toStrictEqual({
      action: "reassigned",
      at: T10,
      target: "refund-tool-approval",
    });
  });

  it("counts as an extension when it says so: a `timeout-changed` entry with the same facts follows", () => {
    const done = inPlace(sentPause(), {
      assignees: ["deputy"],
      actor,
      reason: "later",
      timeout: { expiresAt: T12 },
      countsAsExtension: true,
    });

    const [moved, extended] = done?.pause.trail.slice(-2) ?? [];
    expect(extended).toStrictEqual({ ...moved, action: "timeout-changed" });
    expect(done?.pause.trail.map((entry) => entry.action)).toEqual([
      "opened",
      "reassigned",
      "timeout-changed",
    ]);
  });

  it("tells the channel and the listeners `reassigned` once the pause was sent, with what changed", () => {
    const done = inPlace(sentPause(), { assignees: ["deputy"], timeout: { expiresAt: T12 } });

    expect(done?.notices.map((one) => one.recipient)).toEqual([
      "channel:refund",
      "listener:metrics",
    ]);
    expect(done?.notices[0]).toMatchObject({ at: AT });
    expect(done?.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.Reassigned,
      writtenAt: T10,
      expiresAt: T12,
      previousExpiresAt: T11,
      assignees: ["deputy"],
      previousAssignees: ["clerk"],
      previousTarget: "refund-tool-approval",
      previousChannel: "refund",
      previousExternalRef: "JIRA-1",
    });
  });

  it("tells only what there is: a bare pause and a bare call make a notice of the kind, the time and the target", () => {
    const bare = sentPause({
      channel: undefined,
      externalRef: undefined,
      expiresAt: undefined,
      assignees: undefined,
    });
    const done = inPlace(bare, {}, { listeners: ["metrics"] });

    expect(done?.notices.map((one) => one.recipient)).toEqual(["listener:metrics"]);
    expect(done?.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.Reassigned,
      writtenAt: T10,
      previousTarget: "refund-tool-approval",
    });
  });

  it("writes no notice while the pause is unsent (its first send tells it later)", () => {
    expect(inPlace(sentPause({ isSent: false }), { assignees: ["deputy"] })?.notices).toEqual([]);
  });

  it("applies only while the pause is as seen, open (or due, for an expiry's), under its limits", () => {
    const pause = sentPause();
    const unseen = { ...pause, trail: [...pause.trail, ...pause.trail] };

    expect(
      reassignChange(unseen, { assignees: ["x"], seen: seenOf(pause) }, new Set(), AT, RECIPIENTS),
    ).toBeUndefined();
    expect(
      reassignChange(pause, { assignees: ["x"] } as never, new Set(), AT, RECIPIENTS),
    ).toBeUndefined();
    expect(inPlace(sentPause({ expiresAt: T10 }), {})).toBeUndefined();
    expect(inPlace(pause, { due: {} })).toBeUndefined();
    expect(inPlace(sentPause({ expiresAt: T10 }), { due: {} })).toBeDefined();
    expect(inPlace(sentPause({ status: PauseStatus.Resolved }), {})).toBeUndefined();
    const held = sentPause({
      trail: [...pauseOf("p-1").trail, { action: "reassigned", at: T9, target: "t" }],
    });
    expect(inPlace(held, { maxReassignments: 1 })).toBeUndefined();
    expect(inPlace(held, { maxReassignments: 2 })).toBeDefined();
  });

  it("is refused at maxExtensions only when it counts as an extension and names a limit", () => {
    const extended = sentPause({
      trail: [...pauseOf("p-1").trail, { action: "timeout-changed", at: T9, target: "t" }],
    });
    const limited = { maxExtensions: 1, timeout: { expiresAt: T12 } };

    expect(inPlace(extended, { ...limited, countsAsExtension: true })).toBeUndefined();
    expect(inPlace(extended, limited)).toBeDefined();
    expect(inPlace(extended, { countsAsExtension: true })).toBeDefined();
    expect(
      inPlace(extended, { ...limited, maxExtensions: 2, countsAsExtension: true }),
    ).toBeDefined();
  });
});

describe("a replacement", () => {
  it("closes the old pause `Reassigned` and tells only its channel `closed`, the listeners hearing `reassigned` from the replacement", () => {
    const pause = sentPause();
    const done = reassignChange(
      pause,
      { pauseId: "p-2", assignees: ["deputy"], seen: seenOf(pause) },
      new Set(),
      AT,
      RECIPIENTS,
    );

    expect(done?.pause).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Reassigned,
      reassignedTo: "p-2",
    });
    expect(done?.notices.map((one) => [one.recipient, one.notice.kind])).toEqual([
      ["channel:refund", PauseNoticeKind.Closed],
    ]);
    expect(done?.inserted).toMatchObject({ pauseId: "p-2", assignees: ["deputy"], isSent: false });
  });

  it("with no channel on the pause, tells nobody (no `closed` to a channel that is not there)", () => {
    const pause = sentPause({ channel: undefined });
    const done = reassignChange(pause, { pauseId: "p-2", seen: seenOf(pause) }, new Set(), AT, {
      listeners: ["metrics"],
    });

    expect(done?.notices).toEqual([]);
  });
});
