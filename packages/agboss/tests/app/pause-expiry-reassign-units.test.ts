/**
 * #1310a, #1307d, #1356 (shard `pauses`) — an expiry's reassignment on its own (`pause-expiry-reassign.ts`): which
 * requests of `PauseExpiration.reassign(…)` are valid (assignees, timeout, reason, target), how the move is planned
 * (the reason masked, the expiry's own facts), what a store that applies it is told and what is announced — the
 * closed pause only for a replacement —, and what a store that refuses it means: still due (`failed`) or lost.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import {
  movedOnExpiry,
  reassignedOnExpiry,
  reassignmentOf,
  refusedOnExpiry,
} from "../../src/app/pause-expiry-reassign.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { pauseOf, RECIPIENTS } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds } from "../../src/units/index.js";

const mocks = vi.hoisted(() => ({ planOf: vi.fn(), targetOfPause: vi.fn() }));
vi.mock("../../src/app/pause-reassign-plan.js", () => ({ planOf: mocks.planOf }));
vi.mock("../../src/app/answer-permit.js", () => ({ targetOfPause: mocks.targetOfPause }));

const NOW = new Date("2026-01-05T10:00:00.000Z");
const DUE = new Date("2026-01-05T09:00:00.000Z");
const PAUSE: PauseRecord = { ...pauseOf("p-1"), expiresAt: DUE };
const reassign = (options: Parameters<typeof PauseExpiration.reassign>[0]) =>
  PauseExpiration.reassign(options);

describe("#1310a: the reassignment an expiry asks for", () => {
  it("is valid with nothing, or with each of the assignees, a timeout of at least a second, a reason of up to 500 characters and a target class", () => {
    class Next {
      readonly mark = "n";
    }
    for (const options of [
      {},
      { assignees: ["ann"] },
      { assignees: [] },
      { timeout: seconds(1) },
      { reason: "x" },
      { reason: "x".repeat(500) },
      { target: Next },
      { assignees: ["ann"], timeout: seconds(60), reason: "again", target: Next },
    ] as const) {
      const asked = reassign(options);
      expect(reassignmentOf(asked)).toStrictEqual({ reassign: asked });
    }
  });

  it.each([
    ["an assignee that is no key's text", { assignees: [""] }],
    ["a timeout below a second", { timeout: seconds(0) }],
    ["a blank reason", { reason: "   " }],
    ["a reason over 500 characters", { reason: "x".repeat(501) }],
    ["a reason that is no text", { reason: 5 }],
    ["a target that is no class", { target: "next" }],
  ])("is not valid with %s", (_name, options) => {
    expect(reassignmentOf(reassign(options as never))).toBeUndefined();
  });
});

describe("#1310a: an expiry's reassignment applied", () => {
  const storesOf = (changed: unknown, fresh?: unknown) => {
    const reassignBy = vi.fn((..._args: unknown[]) => Promise.resolve(changed));
    const delivered = vi.fn();
    const closed = vi.fn();
    const reassigned = vi.fn();
    return {
      stores: {
        pauses: {
          reassignByTenantIdAndPauseId: reassignBy,
          findByTenantIdAndPauseId: vi.fn(() => Promise.resolve(fresh)),
        },
        notices: { recipientsOf: () => RECIPIENTS, delivered, tally: { closed, reassigned } },
      },
      reassignBy,
      delivered,
      closed,
      reassigned,
    };
  };
  const partsOf = (stores: unknown, observability?: unknown) =>
    ({
      deps: {
        pause: stores,
        config: { name: PAUSE.workflow },
        graph: { nodes: new Map() },
        pii:
          observability === undefined ? undefined : { observability, observed: { policies: [] } },
      },
      clock: { now: () => NOW },
    }) as never;
  const PLAN = { change: { seen: "seen" }, isInPlace: false };

  beforeEach(() => {
    mocks.planOf.mockReset();
    mocks.targetOfPause.mockReset();
    mocks.targetOfPause.mockReturnValue("the target");
    mocks.planOf.mockResolvedValue(PLAN);
  });

  it("is `failed` for a workflow with no pause stores, and for a request that cannot be planned — nothing is applied", async () => {
    const { stores, reassignBy } = storesOf({ pauseId: "p-2" });

    expect(await reassignedOnExpiry(partsOf(undefined), PAUSE, reassign({}))).toBe("failed");
    mocks.planOf.mockRejectedValueOnce(new Error("no deadline can be given"));
    expect(await reassignedOnExpiry(partsOf(stores), PAUSE, reassign({}))).toBe("failed");
    expect(reassignBy).not.toHaveBeenCalled();
  });

  it("plans as an expiry with the request's own facts and the reason masked by the pause's workflow, the pause's own target the source", async () => {
    const { stores } = storesOf({ pauseId: "p-2" });
    const value = vi.fn((text: unknown) => Promise.resolve(`masked(${String(text)})`));
    class Next {
      readonly mark = "n";
    }
    const parts = partsOf(stores, { value });

    await reassignedOnExpiry(
      parts,
      PAUSE,
      reassign({ target: Next, assignees: ["ann"], timeout: seconds(60), reason: "on leave" }),
    );
    await reassignedOnExpiry(partsOf(stores), PAUSE, reassign({ reason: "plain" }));

    expect(mocks.planOf.mock.calls[0]).toEqual([
      { deps: (parts as { deps: unknown }).deps, clock: (parts as { clock: unknown }).clock },
      PAUSE,
      "the target",
      {
        target: Next,
        assignees: ["ann"],
        timeout: seconds(60),
        reason: "masked(on leave)",
        isExpiry: true,
      },
    ]);
    expect(mocks.planOf.mock.calls[1]?.[3]).toMatchObject({ reason: "plain", isExpiry: true });
  });

  it("masks no reason that is not there, and announces a change to a store with no tally or notices as well", async () => {
    const reassignBy = vi.fn((..._args: unknown[]) => Promise.resolve({ pauseId: "p-2" }));
    const value = vi.fn((text: unknown) => Promise.resolve(`masked(${String(text)})`));
    const bare = {
      pauses: { reassignByTenantIdAndPauseId: reassignBy },
      notices: { recipientsOf: () => RECIPIENTS, delivered: vi.fn() },
    };

    expect(await reassignedOnExpiry(partsOf(bare, { value }), PAUSE, reassign({}))).toBe("done");

    expect(value).not.toHaveBeenCalled();
    expect(mocks.planOf.mock.calls[0]?.[3]).toMatchObject({ reason: undefined });
  });

  it("applies the plan's change at the clock's now with the pause's recipients; a replacement closes the old pause in the tally, an in-place change does not — both announce the change", async () => {
    const changed = { pauseId: "p-2" };
    const moved = storesOf(changed);
    const inPlace = storesOf(changed);
    mocks.planOf.mockResolvedValueOnce(PLAN).mockResolvedValueOnce({ ...PLAN, isInPlace: true });

    expect(await reassignedOnExpiry(partsOf(moved.stores), PAUSE, reassign({}))).toBe("done");
    expect(await reassignedOnExpiry(partsOf(inPlace.stores), PAUSE, reassign({}))).toBe("done");

    expect(moved.reassignBy).toHaveBeenCalledWith(
      PAUSE.tenantId,
      PAUSE.pauseId,
      PLAN.change,
      NOW,
      RECIPIENTS,
    );
    expect(moved.closed).toHaveBeenCalledExactlyOnceWith({
      ...PAUSE,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Reassigned,
      resolvedAt: NOW,
      reassignedTo: "p-2",
    });
    expect(moved.reassigned).toHaveBeenCalledExactlyOnceWith(changed);
    expect(moved.delivered).toHaveBeenCalledOnce();
    expect(inPlace.closed).not.toHaveBeenCalled();
    expect(inPlace.reassigned).toHaveBeenCalledExactlyOnceWith(changed);
    expect(inPlace.delivered).toHaveBeenCalledOnce();
  });

  it("a store that refuses is read again: the pause still pending, due as it was and unsent is `failed` (the limit), any other is `lost`", async () => {
    const outcome = async (fresh: unknown) => {
      const { stores, reassigned, delivered } = storesOf(undefined, fresh);
      const result = await reassignedOnExpiry(partsOf(stores), PAUSE, reassign({}));
      expect(reassigned).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      return result;
    };

    expect(await outcome({ ...PAUSE })).toBe("failed");
    expect(await outcome({ ...PAUSE, status: PauseStatus.Resolved })).toBe("lost");
    expect(await outcome({ ...PAUSE, expiresAt: NOW })).toBe("lost");
    expect(await outcome({ ...PAUSE, expiresAt: undefined })).toBe("lost");
    expect(await outcome({ ...PAUSE, isSent: true })).toBe("lost");
    expect(await outcome(undefined)).toBe("lost");
  });

  it("is applied only for a reassignment; any other outcome of an expiry is `failed` for this look", async () => {
    const { stores } = storesOf({ pauseId: "p-2" });

    expect(await movedOnExpiry(partsOf(stores), PAUSE, {})).toBe("failed");
    expect(
      await movedOnExpiry(partsOf(stores), PAUSE, { problem: "handler-failed" } as never),
    ).toBe("failed");
    expect(await movedOnExpiry(partsOf(stores), PAUSE, { reassign: reassign({}) })).toBe("done");
  });

  it("`refusedOnExpiry` reads the pause by its tenant and id", async () => {
    const { stores } = storesOf(undefined, PAUSE);

    expect(await refusedOnExpiry(stores as never, PAUSE)).toBe("failed");
    expect(stores.pauses.findByTenantIdAndPauseId).toHaveBeenCalledWith(
      PAUSE.tenantId,
      PAUSE.pauseId,
    );
  });
});
