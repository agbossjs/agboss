/**
 * #1307, #1356 (shard `pauses`) — what a timeout change's request and a reassignment's refusals say, on their own
 * (`timeout-request.ts`, `pause-reassign-support.ts`): the request is checked field by field with the DTO's own
 * issue, the reason is masked by the pause's own workflow, a pause whose first send may be in flight is refused,
 * and a refused reassignment says why — closed, a limit, or a writer that won — with the pause named by its key.
 */
import { describe, expect, it, vi } from "vitest";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { ValidationError } from "../../src/core/error-families/effect-errors.js";
import {
  assertNotInFirstSend,
  maskedReason,
  ownTargetOf,
  refusedReassignment,
} from "../../src/app/pause-reassign-support.js";
import { checked } from "../../src/app/timeout-request.js";
import {
  pauseKeyOf,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds, Timeout, workingHours } from "../../src/units/index.js";

const PAUSE: PauseRecord = pauseOf("p-1");
const KEY = pauseKeyOf(PAUSE.tenantId, PAUSE.pauseId);

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};
const caughtAsync = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#1307: a timeout change's request", () => {
  const issueOf = (request: unknown) => {
    const error = caught(() => checked(request));
    expect(error).toBeInstanceOf(ValidationError.DtoInvalid);
    return error as Error & { dto: string; issues: unknown };
  };

  it("is the pause's id, its timeout and a reason only when given", () => {
    expect(checked({ pauseId: "p-1", timeout: seconds(30) })).toStrictEqual({
      pauseId: "p-1",
      timeout: seconds(30),
    });
    expect(checked({ pauseId: "p-1", timeout: Timeout.None, reason: "later" })).toStrictEqual({
      pauseId: "p-1",
      timeout: Timeout.None,
      reason: "later",
    });
    expect(checked({ pauseId: "p-1", timeout: workingHours(8) })).toHaveProperty("timeout");
  });

  it.each([undefined, null, "p-1", 5, {}, { pauseId: "" }, { pauseId: 7 }])(
    "of %j with no pause id is refused naming the id, the DTO and its issue",
    (request) => {
      const error = issueOf(request);

      expect(error.message).toBe(
        "invalid SetPauseTimeoutRequest: .pauseId: a pause's id is a non-empty text",
      );
      expect(error.dto).toBe("SetPauseTimeoutRequest");
      expect(error.issues).toEqual([
        { path: ".pauseId", reason: "a pause's id is a non-empty text" },
      ]);
    },
  );

  it.each([" ", "", 5, "x".repeat(501)])(
    "with the reason %j is refused naming the reason",
    (reason) => {
      const error = issueOf({ pauseId: "p-1", timeout: seconds(30), reason });

      expect(error.message).toBe(
        "invalid SetPauseTimeoutRequest: .reason: a reason is a non-blank text of at most 500 characters",
      );
      expect(error.dto).toBe("SetPauseTimeoutRequest");
      expect(error.issues).toEqual([
        { path: ".reason", reason: "a reason is a non-blank text of at most 500 characters" },
      ]);
    },
  );

  it("takes a reason of exactly the longest length", () => {
    expect(
      checked({ pauseId: "p-1", timeout: seconds(30), reason: "x".repeat(500) }),
    ).toHaveProperty("reason", "x".repeat(500));
  });

  it.each([5, seconds(0), "soon", undefined, Number.POSITIVE_INFINITY])(
    "with the timeout %j is refused with the timeout's rule, the value named",
    (timeout) => {
      const error = caught(() => checked({ pauseId: "p-1", timeout }));

      expect(error).toBeInstanceOf(PauseError.InvalidTimeout);
      expect((error as Error).message).toContain(
        "is no timeout — a finite duration of at least seconds(1) and at most 5 years, like hours(24) or workHours(8), or Timeout.None",
      );
    },
  );
});

describe("#1307d: a reassignment's reason and target", () => {
  const depsOf = (observability: unknown, target?: unknown) =>
    ({
      config: { name: PAUSE.workflow },
      graph: { nodes: new Map() },
      pii: observability === undefined ? undefined : { observability, observed: { policies: [] } },
      targetOf: () => target,
    }) as never;

  it("the reason goes through the pause's own workflow's mask, none when there is none, and nothing for no reason", async () => {
    const value = vi.fn((text: unknown) => Promise.resolve(`masked(${String(text)})`));

    expect(await maskedReason(depsOf({ value }), PAUSE, "on leave")).toBe("masked(on leave)");
    expect(await maskedReason(depsOf(undefined), PAUSE, "on leave")).toBe("on leave");
    expect(await maskedReason(depsOf({ value }), PAUSE, undefined)).toBeUndefined();
    expect(value).toHaveBeenCalledOnce();
  });

  it("the pause's own target is its workflow's now; a deploy that removed it refuses the call, the lookup's failure its cause", () => {
    const target = { name: "refund-tool-approval" };

    expect(ownTargetOf(depsOf(undefined, target), PAUSE)).toBe(target);
    const error = caught(() => ownTargetOf(depsOf(undefined, undefined), PAUSE));

    expect(error).toBeInstanceOf(PauseError.IncompatibleTarget);
    expect((error as Error).message).toBe(
      `pause ${KEY}: its target is no longer in this application`,
    );
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe("#946: a pause whose first send may be in flight", () => {
  const target = { channels: new Map([["refund-approval-channel", {}]]) } as never;
  const refused = (pause: PauseRecord, to = target) => {
    const error = caught(() => { assertNotInFirstSend(pause, to); });
    if (error === undefined) return undefined;
    expect(error).toBeInstanceOf(PauseError.UpdateContended);
    return (error as Error).message;
  };

  it("is refused, naming the pause and that a retry is safe", () => {
    expect(refused(PAUSE)).toBe(
      `pause ${KEY}: its channel is still being asked; retry is safe once the send returned`,
    );
  });

  it("is an owner's pause with no channel, marked at once — refused as well", () => {
    expect(refused({ ...PAUSE, channel: undefined })).toBeDefined();
  });

  it.each([
    ["one marked sent", { isSent: true }],
    ["a replacement a reassignment made", { reassignedFrom: "p-0" }],
    ["one that is no longer pending", { status: PauseStatus.Resolved }],
    ["one whose channel a deploy removed", { channel: "removed-channel" }],
  ])("is not one: %s", (_name, changes) => {
    expect(refused({ ...PAUSE, ...changes })).toBeUndefined();
  });
});

describe("#1307d: a reassignment the store did not apply", () => {
  const NOW = new Date("2026-01-05T10:00:00.000Z");
  const refusal = (fresh: PauseRecord | undefined, max?: number) =>
    refusedReassignment(
      {
        clock: { now: () => NOW } as never,
        pauses: { findByTenantIdAndPauseId: () => Promise.resolve(fresh) } as never,
      },
      PAUSE,
      max,
    );
  const pending = { ...PAUSE, expiresAt: new Date("2026-01-05T11:00:00.000Z") };

  it("a pause that closed meanwhile, or whose deadline is due, is told as closed", async () => {
    expect(await refusal({ ...pending, status: PauseStatus.Resolved })).toBeInstanceOf(
      PauseError.Closed,
    );
    expect(await refusal({ ...pending, expiresAt: NOW })).toBeInstanceOf(PauseError.Closed);
    // a record gone is read as the pause the call had: still waiting, so another writer won
    expect(await refusal(undefined)).toBeInstanceOf(PauseError.UpdateContended);
  });

  it("a limit reached is the limit's refusal, naming it; a limit not reached is a writer that won", async () => {
    const reassigned = {
      ...pending,
      trail: [
        ...pending.trail,
        { action: "reassigned" as const, at: NOW, target: pending.target },
        { action: "reassigned" as const, at: NOW, target: pending.target },
      ],
    };

    const limit = await refusal(reassigned, 2);
    const beyond = await refusal(reassigned, 3);
    const none = await refusal(reassigned, undefined);

    expect(limit.message).toContain("maxReassignments");
    for (const won of [beyond, none]) {
      expect(won).toBeInstanceOf(PauseError.UpdateContended);
      expect(won.message).toBe(`pause ${KEY}: another change won; retry is safe`);
    }
  });
});
