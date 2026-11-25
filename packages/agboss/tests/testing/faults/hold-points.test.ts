import { StoreError } from "../../../src/core/error-families/store-errors.js";
import { describe, expect, it } from "vitest";
import { StoreOutcomeSource } from "../../../src/index.js";
import {
  HoldPhase,
  HoldPoints,
  StoreAnswerLostError,
  type HeldOperation,
} from "../../../src/testing/faults/hold-points.js";
import {
  StoreOutage,
  StoreOutageError,
  StoreOutageMode,
} from "../../../src/testing/faults/store-outage.js";

/** Whether `promise` settled by the next turn of the event loop. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe("#484 AC5: hold points — an armed point holds the next matching operation until released", () => {
  it("an unarmed point lets every operation through at once", async () => {
    const points = new HoldPoints();
    expect(
      await settled(
        points.reach({ point: "lease.acquire", phase: HoldPhase.Before, key: "root-1" }),
      ),
    ).toBe(true);
  });

  it("a hold holds the next arrival with its key and phase, announces it, and lets it go on release", async () => {
    const points = new HoldPoints();
    const heard: HeldOperation[] = [];
    points.onHeld((operation) => heard.push(operation));
    const armId = points.arm({ point: "lease.acquire", key: "root-1" });
    // another key, another phase, another point: through
    expect(
      await settled(
        points.reach({ point: "lease.acquire", phase: HoldPhase.Before, key: "root-2" }),
      ),
    ).toBe(true);
    expect(
      await settled(
        points.reach({ point: "lease.acquire", phase: HoldPhase.After, key: "root-1" }),
      ),
    ).toBe(true);
    expect(
      await settled(points.reach({ point: "lease.renew", phase: HoldPhase.Before, key: "root-1" })),
    ).toBe(true);
    const held = points.reach({ point: "lease.acquire", phase: HoldPhase.Before, key: "root-1" });
    expect(await settled(held)).toBe(false);
    expect(heard).toEqual([
      { holdId: "hold-2", armId, point: "lease.acquire", phase: HoldPhase.Before, key: "root-1" },
    ]);
    expect(points.held).toEqual(heard);
    expect(points.release("hold-2")).toBe(true);
    expect(await settled(held)).toBe(true);
    expect(points.release("hold-2")).toBe(false);
    // used up: the next arrival goes through
    expect(
      await settled(
        points.reach({ point: "lease.acquire", phase: HoldPhase.Before, key: "root-1" }),
      ),
    ).toBe(true);
  });

  it("a hold without a key holds any key, `times` arrivals, each its own hold", async () => {
    const points = new HoldPoints();
    points.arm({ point: "fencedEffect.write", phase: HoldPhase.After, times: 2 });
    const first = points.reach({ point: "fencedEffect.write", phase: HoldPhase.After, key: "a" });
    const second = points.reach({
      point: "fencedEffect.write",
      phase: HoldPhase.After,
      key: undefined,
    });
    expect(
      await settled(
        points.reach({ point: "fencedEffect.write", phase: HoldPhase.After, key: "c" }),
      ),
    ).toBe(true);
    expect(points.held.map((operation) => operation.key)).toEqual(["a", undefined]);
    points.releaseAll();
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(true);
  });

  it("a disarmed hold holds nothing more, and keeps what it holds", async () => {
    const points = new HoldPoints();
    const armId = points.arm({ point: "p", times: 3 });
    const held = points.reach({ point: "p", phase: HoldPhase.Before, key: undefined });
    points.disarm(armId);
    points.disarm("arm-none");
    expect(
      await settled(points.reach({ point: "p", phase: HoldPhase.Before, key: undefined })),
    ).toBe(true);
    expect(await settled(held)).toBe(false);
    points.releaseAll();
    expect(await settled(held)).toBe(true);
  });

  it("a step's signal ends its wait with its reason, at once when it aborted already", async () => {
    const points = new HoldPoints();
    points.arm({ point: "step.charge.before", times: 2 });
    const step = new AbortController();
    const held = points.reach({
      point: "step.charge.before",
      phase: HoldPhase.Before,
      key: "o-1",
      signal: step.signal,
    });
    step.abort(new Error("lease lost"));
    await expect(held).rejects.toThrow("lease lost");
    expect(points.held).toEqual([]);
    const aborted = new AbortController();
    aborted.abort("stopping");
    await expect(
      points.reach({
        point: "step.charge.before",
        phase: HoldPhase.Before,
        key: "o-1",
        signal: aborted.signal,
      }),
    ).rejects.toThrow("the step stopped");
  });

  it("refuses a hold of no arrival, and stops a listener on its call", async () => {
    const points = new HoldPoints();
    expect(() => points.arm({ point: "p", times: 0 })).toThrow(RangeError);
    const heard: string[] = [];
    const stop = points.onHeld((operation) => heard.push(operation.holdId));
    stop();
    points.arm({ point: "p" });
    void points.reach({ point: "p", phase: HoldPhase.Before, key: undefined });
    expect(heard).toEqual([]);
    points.releaseAll();
  });
});

describe("#720: a lost answer — the operation took effect, its caller hears an error", () => {
  it("loses the next keyed answers after the store, as many as armed, holds none and announces none", async () => {
    const points = new HoldPoints();
    const heard: HeldOperation[] = [];
    points.onHeld((operation) => heard.push(operation));
    points.arm({ point: "childQueue.claim", phase: HoldPhase.After, times: 2, loseAnswer: true });
    // an answer with no key (a claim of nothing) and another phase: through
    await expect(
      points.reach({ point: "childQueue.claim", phase: HoldPhase.After, key: undefined }),
    ).resolves.toBeUndefined();
    await expect(
      points.reach({ point: "childQueue.claim", phase: HoldPhase.Before, key: "c-1" }),
    ).resolves.toBeUndefined();
    await expect(
      points.reach({ point: "childQueue.claim", phase: HoldPhase.After, key: "c-1" }),
    ).rejects.toThrow(StoreAnswerLostError);
    await expect(
      points.reach({ point: "childQueue.claim", phase: HoldPhase.After, key: "c-2" }),
    ).rejects.toThrow("the answer of childQueue.claim was lost");
    await expect(
      points.reach({ point: "childQueue.claim", phase: HoldPhase.After, key: "c-3" }),
    ).resolves.toBeUndefined();
    expect(heard).toEqual([]);
    expect(points.held).toEqual([]);
  });

  it("#1017: asTransportError loses the answer as a transport error of unknown outcome, the lost answer its cause", async () => {
    const points = new HoldPoints();
    points.arm({
      ...{ point: "fencedEffect.write", phase: HoldPhase.After, loseAnswer: true },
      asTransportError: true,
    });

    const error: unknown = await points
      .reach({ point: "fencedEffect.write", phase: HoldPhase.After, key: "k-1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(StoreError.OutcomeUnknown);
    expect(error).toMatchObject({
      operation: "fencedEffect.write",
      source: StoreOutcomeSource.Transport,
      cause: expect.any(StoreAnswerLostError),
    });
  });

  it("#1017: asTransportError reads a lost answer: armed without loseAnswer it is refused", () => {
    const points = new HoldPoints();
    expect(() =>
      points.arm({ point: "fencedEffect.write", phase: HoldPhase.After, asTransportError: true }),
    ).toThrow(RangeError);
  });

  it("only an answer can be lost: a lose before the store is refused when armed", () => {
    const points = new HoldPoints();
    expect(() => points.arm({ point: "childQueue.claim", loseAnswer: true })).toThrow(RangeError);
  });
});

describe("#484 scenario 8: a store outage refuses or hangs every held operation until it ends", () => {
  it("refuses while `Refuse`, hangs while `Hang`, lets everything through once ended", async () => {
    const outage = new StoreOutage();
    await expect(outage.passed("lease.renew")).resolves.toBeUndefined();
    outage.begin(StoreOutageMode.Refuse);
    expect(outage.mode).toBe(StoreOutageMode.Refuse);
    await expect(outage.passed("lease.renew")).rejects.toThrow(StoreOutageError);
    outage.begin(StoreOutageMode.Hang);
    const waiting = outage.passed("lease.renew");
    expect(await settled(waiting)).toBe(false);
    outage.end();
    expect(outage.mode).toBeUndefined();
    expect(await settled(waiting)).toBe(true);
  });
});
