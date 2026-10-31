/**
 * #533 item 3 — the holder's fence and its background renewal as units, on a `VirtualClock`: an
 * answer that comes once the fence is lost or ran out moves no deadline and fails as the fence did;
 * the renewal loop stops at a lost lease and retries any other failure.
 */
import { describe, expect, it } from "vitest";
import { LeaseFence, renewInBackground, sentAtOf } from "../../src/app/lease-fence.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";

/** A fence that began now with `remaining` left, and its controller. */
function fenceOf(clock: VirtualClock, remaining: number) {
  const lost = new AbortController();
  const fence = new LeaseFence(clock, { sentAt: sentAtOf(clock), remaining }, lost, "root-1");
  return { fence, lost };
}

describe("#533: an answer to a fence that is over", () => {
  it("a confirmed renewal after the fence was lost moves no deadline: it throws the loss", async () => {
    const clock = new VirtualClock();
    const { fence, lost } = fenceOf(clock, seconds(30));
    const loss = new ExecutionLeaseLostError("root-1");
    lost.abort(loss);
    const until = fence.confirmedUntil;
    await clock.advance(seconds(10));

    expect(() => {
      fence.settle(sentAtOf(clock), seconds(30));
    }).toThrow(loss);
    expect(fence.confirmedUntil).toBe(until);
  });

  it("a renewal the store did not answer, once the fence ran out: expired, its deadline where it was", async () => {
    const clock = new VirtualClock();
    const { fence, lost } = fenceOf(clock, seconds(5));
    const until = fence.confirmedUntil;
    await clock.advance(seconds(10));

    expect(() => {
      fence.settle(sentAtOf(clock), undefined);
    }).toThrow(ExecutionLeaseLostError);
    expect(lost.signal.aborted).toBe(true);
    expect(fence.confirmedUntil).toBe(until);
  });

  it("a renewal confirmed with no time left, once the fence ran out: expired", async () => {
    const clock = new VirtualClock();
    const { fence, lost } = fenceOf(clock, seconds(5));
    await clock.advance(seconds(10));

    expect(() => {
      fence.settle(sentAtOf(clock), 0 as Milliseconds);
    }).toThrow(ExecutionLeaseLostError);
    expect(lost.signal.aborted).toBe(true);
  });
});

describe("#533: the background renewal", () => {
  /** Runs the loop for three renewal periods; `failure` is what each renewal throws. */
  async function renewalsWhile(failure: Error): Promise<number> {
    const clock = new VirtualClock();
    const working = new AbortController();
    let renewals = 0;
    const loop = renewInBackground(clock, working.signal, () => {
      renewals += 1;
      return Promise.reject(failure);
    });
    for (let period = 0; period < 3; period += 1) await clock.advance(seconds(10));
    working.abort();
    await loop;
    return renewals;
  }

  it("stops at a lost lease: no renewal after the one that found it", async () => {
    await expect(renewalsWhile(new ExecutionLeaseLostError("root-1"))).resolves.toBe(1);
  });

  it("retries any other failure at the next period", async () => {
    await expect(renewalsWhile(new Error("the lease store is down"))).resolves.toBe(3);
  });
});
