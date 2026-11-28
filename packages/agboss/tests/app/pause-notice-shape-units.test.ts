/**
 * #1356 (pause-notices shard) — what an event says of a pause's question and custody (`pause-notice-shape.ts`) and the
 * timeout-changed event of a listener (`pause-timeout-events.ts`), on their own: each optional part is there only when the
 * pause or the notice has it, every text goes through the mask, a deadline's notice with no deadline is refused naming
 * its kind, and the dates are copies.
 */
import { describe, expect, it, vi } from "vitest";
import {
  askedOf,
  changedDeadlinesOf,
  deadlineOf,
  listenedOf,
  maskedActor,
} from "../../src/app/pause-notice-shape.js";
import { listenerTimeoutChangedOf } from "../../src/app/pause-timeout-events.js";
import { PauseNoticeKind, type PauseNotice } from "../../src/infrastructure/pause-notices.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const AT = new Date("2026-11-20T10:00:00.000Z");
const LATER = new Date("2026-11-20T11:00:00.000Z");
const same = (value: unknown): Promise<unknown> => Promise.resolve(value);
const bare = (): PauseRecord => {
  const { toolCall: _t, assignees: _a, externalRef: _e, ...rest } = pauseOf("p-1");
  return { ...rest, input: { question: "ok?" } };
};
const noticeOf = (changes: Partial<PauseNotice> = {}): PauseNotice => ({
  seq: 1,
  kind: PauseNoticeKind.TimeoutChanged,
  writtenAt: AT,
  ...changes,
});

describe("#1356: what a pause asks", () => {
  it("is its input, with the tool call only when it has one", () => {
    const toolCall = { callId: "c-1", tool: "refund", summary: "refund 5" };

    expect(askedOf({ ...bare(), toolCall })).toStrictEqual({
      input: { question: "ok?" },
      toolCall,
    });
    expect(askedOf(bare())).toStrictEqual({ input: { question: "ok?" } });
  });
});

describe("#1356: what a listener is told of a pause", () => {
  it("has each of the tool call, the assignees and the external reference only when the pause has it, the trail as a copy", async () => {
    const full: PauseRecord = {
      ...bare(),
      toolCall: { callId: "c-1", tool: "refund" },
      assignees: ["ann", "bob"],
      externalRef: "TICKET-1",
    };

    const told = await listenedOf(full, same);

    expect(told).toStrictEqual({
      input: { question: "ok?" },
      toolCall: { callId: "c-1", tool: "refund" },
      assignees: ["ann", "bob"],
      externalRef: "TICKET-1",
      trail: full.trail,
    });
    expect(told.trail).not.toBe(full.trail);
    expect(Object.keys(await listenedOf(bare(), same)).sort()).toEqual(["input", "trail"]);
  });

  it("is what the mask shows: a part the mask drops is not told, one it rewrites is told rewritten", async () => {
    const full: PauseRecord = {
      ...bare(),
      toolCall: { callId: "c-1", tool: "refund" },
      assignees: ["ann"],
      externalRef: "TICKET-1",
    };
    const mask = vi.fn(async (value: unknown) => {
      const { toolCall: _t, assignees: _a, ...kept } = value as Record<string, unknown>;
      return { ...kept, externalRef: "***" };
    });

    const told = await listenedOf(full, mask);

    expect(mask).toHaveBeenCalledOnce();
    expect(Object.keys(told).sort()).toEqual(["externalRef", "input", "trail"]);
    expect(told.externalRef).toBe("***");
  });

  it("an actor goes through the mask as a whole", async () => {
    const mask = vi.fn((actor: unknown) => Promise.resolve({ ...(actor as object), id: "***" }));

    expect(await maskedActor({ masked: mask }, { id: "ann", orgId: "acme" })).toStrictEqual({
      id: "***",
      orgId: "acme",
    });
    expect(mask).toHaveBeenCalledWith({ id: "ann", orgId: "acme" });
  });
});

describe("#1356: the deadlines a notice names", () => {
  it("a notice of a deadline gives it as a copy; with none the store failed to write it, and the notice's kind is named", () => {
    const notice = noticeOf({ kind: PauseNoticeKind.Expiring, expiresAt: AT });

    const deadline = deadlineOf(notice);

    expect(deadline).toStrictEqual(AT);
    expect(deadline).not.toBe(AT);
    expect(() => deadlineOf(noticeOf({ kind: PauseNoticeKind.Expiring }))).toThrow(
      new TypeError("a expiring notice names its deadline"),
    );
  });

  it("a timeout change moved between the deadlines it has, each a copy and each absent when the pause had, or has, none", () => {
    const both = changedDeadlinesOf(noticeOf({ expiresAt: LATER, previousExpiresAt: AT }));

    expect(both).toStrictEqual({ expiresAt: LATER, previousExpiresAt: AT });
    expect(both.expiresAt).not.toBe(LATER);
    expect(both.previousExpiresAt).not.toBe(AT);
    expect(changedDeadlinesOf(noticeOf({ expiresAt: LATER }))).toStrictEqual({ expiresAt: LATER });
    expect(changedDeadlinesOf(noticeOf({ previousExpiresAt: AT }))).toStrictEqual({
      previousExpiresAt: AT,
    });
    expect(changedDeadlinesOf(noticeOf())).toStrictEqual({});
  });
});

describe("#1356: the timeout-changed event of a listener", () => {
  it("tells who changed it and why, the actor through the mask, and nothing of either when the notice has none", async () => {
    const mask = vi.fn((value: unknown) =>
      Promise.resolve(
        typeof value === "object" && value !== null && "id" in value
          ? { ...value, id: "***" }
          : value,
      ),
    );
    const sources = (notice: PauseNotice) => ({
      pause: bare(),
      notice,
      deliveryId: "d-1",
      masked: mask,
    });

    const changed = await listenerTimeoutChangedOf(
      sources(
        noticeOf({
          expiresAt: LATER,
          previousExpiresAt: AT,
          actor: { id: "ann" },
          changeReason: "customer asked",
        }),
      ),
      true,
    );
    const anonymous = await listenerTimeoutChangedOf(sources(noticeOf({ expiresAt: LATER })), true);

    expect(changed).toMatchObject({
      expiresAt: LATER,
      previousExpiresAt: AT,
      actor: { id: "***" },
      reason: "customer asked",
    });
    // the mask saw the pause's values once for the second event, never an actor that is not there
    expect(mask.mock.calls.filter(([value]) => value === undefined)).toEqual([]);
    expect(mask).toHaveBeenCalledTimes(3);
    expect(anonymous).toMatchObject({ expiresAt: LATER });
    expect(anonymous).not.toHaveProperty("actor");
    expect(anonymous).not.toHaveProperty("reason");
    expect(anonymous).not.toHaveProperty("previousExpiresAt");
  });
});
