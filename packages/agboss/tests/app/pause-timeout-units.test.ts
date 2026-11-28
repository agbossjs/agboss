/**
 * #1307, #942, #1356 (shard `pauses`) — `app.setPauseTimeout` on its own (`pause-timeout.ts`): a stopping application
 * refuses first, a deadline past the run's or quorum's bound is refused naming it, a target that guards answers but
 * not a shortened deadline refuses it, a target that is gone refuses through its permit — never as a
 * pause in a send —, and a change that won tells both deadlines to the hooks and gives them back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { setPauseTimeoutOf } from "../../src/app/pause-timeout.js";
import { pauseKeyOf, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { pauseOf, RECIPIENTS } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds } from "../../src/units/index.js";

const mocks = vi.hoisted(() => ({ told: vi.fn() }));
vi.mock("../../src/app/pause-change-events.js", () => ({ toldTimeoutChanged: mocks.told }));

const NOW = new Date("2026-01-05T10:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const PAUSE: PauseRecord = { ...pauseOf("p-1"), isSent: true, expiresAt: at(3_600_000) };
const KEY = pauseKeyOf(PAUSE.tenantId, PAUSE.pauseId);
const CALL = { actor: { id: "ops-1" } };

function appOf(
  options: {
    pause?: PauseRecord;
    target?: unknown;
    accepting?: () => void;
    changed?: unknown;
  } = {},
) {
  const change = vi.fn((..._args: unknown[]) =>
    Promise.resolve("changed" in options ? options.changed : { pauseId: PAUSE.pauseId }),
  );
  const delivered = vi.fn();
  const timeoutChanged = vi.fn();
  const target = "target" in options ? options.target : { name: PAUSE.target, channels: new Map() };
  const stored = options.pause ?? PAUSE;
  const parts = {
    pauses: {
      findByTenantIdAndPauseId: vi.fn(() => Promise.resolve(stored)),
      changeTimeoutByTenantIdAndPauseId: change,
    },
    clock: { now: () => NOW },
    accepting: options.accepting ?? (() => undefined),
    owned: () => Promise.resolve(),
    deps: {
      config: { name: PAUSE.workflow },
      graph: { nodes: new Map() },
      targetOf: () => {
        if (target instanceof Error) throw target;
        return target;
      },
      pause: {
        pauses: {},
        notices: { recipientsOf: () => RECIPIENTS, delivered, tally: { timeoutChanged } },
      },
    },
  } as never;
  return { set: setPauseTimeoutOf(parts), parts, change, delivered, timeoutChanged };
}

const refusal = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("not refused");
};

beforeEach(() => {
  mocks.told.mockReset();
  mocks.told.mockResolvedValue(undefined);
});

describe("#1307: a timeout change", () => {
  it("is refused first by an application that is stopping: nothing is read", async () => {
    const stopping = new Error("the application is stopping");
    const { set, parts } = appOf({
      accepting: () => {
        throw stopping;
      },
    });

    await expect(set({ pauseId: "p-1", timeout: seconds(60) }, CALL)).rejects.toBe(stopping);

    expect(
      (parts as { pauses: { findByTenantIdAndPauseId: ReturnType<typeof vi.fn> } }).pauses
        .findByTenantIdAndPauseId,
    ).not.toHaveBeenCalled();
  });

  it("past the deadline of the run or quorum the pause was made under is refused naming it; exactly that deadline is allowed", async () => {
    const { set } = appOf({ pause: { ...PAUSE, boundAt: at(60_000) } });

    const error = await refusal(set({ pauseId: "p-1", timeout: seconds(61) }, CALL));
    const exact = await set({ pauseId: "p-1", timeout: seconds(60) }, CALL);

    expect(error).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect(error.message).toBe(`pause ${KEY}: its run or quorum deadline limit is reached`);
    expect(exact).toEqual({ expiresAt: at(60_000), previousExpiresAt: PAUSE.expiresAt });
  });

  it("that shortens the deadline of a target that guards answers but declares no permitTimeoutChange is refused, a longer one is not", async () => {
    const guarded = {
      name: PAUSE.target,
      channels: new Map(),
      permitAnswer: () => Promise.resolve(true),
    };
    const { set } = appOf({ target: guarded });

    const error = await refusal(set({ pauseId: "p-1", timeout: seconds(60) }, CALL));
    const longer = await set({ pauseId: "p-1", timeout: seconds(7200) }, CALL);

    expect(error).toBeInstanceOf(PauseError.PermissionDenied);
    expect(error.message).toBe(
      `pause ${KEY}: its target guards answers with permitAnswer but has no permitTimeoutChange, so a change that is not a longer deadline is refused`,
    );
    expect(longer).toHaveProperty("expiresAt", at(7_200_000));
  });

  it("of a pause whose target is gone is refused by the permit, even while its first send is in flight", async () => {
    const { set } = appOf({
      pause: { ...PAUSE, isSent: false },
      target: new Error("Unknown pause target: refund-tool-approval"),
    });

    const error = await refusal(set({ pauseId: "p-1", timeout: seconds(60) }, CALL));

    expect(error).toBeInstanceOf(PauseError.PermissionDenied);
    expect(error.message).toBe(
      `pause ${KEY}: its target cannot be resolved, the timeout change is refused`,
    );
  });

  it("that won tells the hooks both deadlines, stores the change over the pause as read, and gives both back", async () => {
    const { set, change, delivered, timeoutChanged } = appOf();

    const result = await set(
      { pauseId: "p-1", timeout: seconds(60), reason: "customer asked" },
      CALL,
    );

    expect(result).toEqual({ expiresAt: at(60_000), previousExpiresAt: PAUSE.expiresAt });
    expect(change).toHaveBeenCalledExactlyOnceWith(
      PAUSE.tenantId,
      PAUSE.pauseId,
      {
        seen: expect.objectContaining({ trailLength: PAUSE.trail.length, isSent: true }),
        expiresAt: at(60_000),
        previousExpiresAt: PAUSE.expiresAt,
        actor: CALL.actor,
        reason: "customer asked",
      },
      NOW,
      RECIPIENTS,
    );
    expect(mocks.told).toHaveBeenCalledExactlyOnceWith(expect.anything(), PAUSE, {
      previousExpiresAt: PAUSE.expiresAt,
      expiresAt: at(60_000),
    });
    expect(delivered).toHaveBeenCalledOnce();
    expect(timeoutChanged).toHaveBeenCalledOnce();
  });

  it("that loses the compare-and-set eight times in a row is UpdateContended; one that wins on the way is the result", async () => {
    const lost = appOf({ changed: undefined });
    const error = await refusal(lost.set({ pauseId: "p-1", timeout: seconds(60) }, CALL));

    expect(error).toBeInstanceOf(PauseError.UpdateContended);
    expect(lost.change).toHaveBeenCalledTimes(8);
    expect(mocks.told).not.toHaveBeenCalled();
  });
});
