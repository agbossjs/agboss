/**
 * #1366: the per-minute token window of a provider's gate — a call starts only while the window's used tokens are
 * strictly below the limit: a window that holds exactly the limit lets nobody in until the tokens leave it.
 */
import { describe, expect, it } from "vitest";
import { RateLimitPolicy } from "../../src/models/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";

const ticket = { tenantId: "t1", weight: 1, signal: undefined };

/** A gate under `perMinute.tokens: 20` whose window already holds `used` tokens. */
async function gateUsing(used: number, clock: VirtualClock) {
  const gate = instanceCalls(clock).gateOf(
    "limited-model-provider",
    RateLimitPolicy.of({ perMinute: { tokens: 20 } }),
  );
  if (gate === undefined) throw new Error("no gate");
  const first = await gate.enter(ticket);
  await first.release(used);
  return gate;
}

/** Whether a call asking now is let in within `wait` of the clock's time. */
async function isAdmitted(
  gate: Awaited<ReturnType<typeof gateUsing>>,
  clock: VirtualClock,
  wait = seconds(1),
) {
  let admitted = false;
  void gate.enter(ticket).then(() => {
    admitted = true;
  });
  await clock.advance(wait);
  return admitted;
}

describe("#1366: the tokens left in the window", () => {
  it("a window below the limit lets the next call in", async () => {
    const clock = new VirtualClock();
    const gate = await gateUsing(19, clock);

    expect(await isAdmitted(gate, clock)).toBe(true);
  });

  it("a window at exactly the limit lets nobody in, until its tokens leave it a minute later", async () => {
    const clock = new VirtualClock();
    const gate = await gateUsing(20, clock);

    expect(await isAdmitted(gate, clock, seconds(30))).toBe(false);
    await clock.advance(seconds(31));
    // the call that waited is let in once the window has emptied
    expect(await isAdmitted(gate, clock)).toBe(true);
  });
});
