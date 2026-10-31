import type { TestLeases } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import type { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";
import { until } from "../../helpers/until.js";
import { rejectionOf, settle } from "./fence-takeover.js";
import { childrenIn, endOnceSeen, rootsIn, type Announced } from "./child-end-once.workflow.js";
import { openGate, yieldSeen } from "./remote-child-yield.workflow.js";

/**
 * #562, #596 — the moves of a child-end test on several instances: every instance ready, live time
 * in steps a live holder renews in, the parent's holder frozen at its child's first announcement
 * while another instance takes the tree over, then thawed; and what the observers heard.
 */

export interface Fixtures {
  readonly clock: VirtualClock;
  readonly leases: TestLeases;
}

/** Every instance ready, the last first: `instance-1` is the last of `apps` (names follow starts). */
export async function readyAll(apps: readonly TestApp[]): Promise<ReadonlyMap<string, TestApp>> {
  const order = [...apps].reverse();
  for (const app of order) await app.ready();
  return new Map(order.map((app, index) => [`instance-${String(index + 1)}`, app]));
}

/** `steps` times 10 s: every live holder renews, a frozen one's lease runs out and is recovered. */
export async function liveFor(clock: VirtualClock, steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) await clock.advance(seconds(10));
}

/** `act` the first time only. */
export const once = <T>(act: (value: T) => void): ((value: T) => void) => {
  let isDone = false;
  return (value) => {
    if (isDone) return;
    isDone = true;
    act(value);
  };
};

/** A promise the test opens. */
export function gateOf(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** What the observers heard, by who ended. */
export interface Heard {
  readonly childEnds: readonly Announced[];
  readonly childErrors: readonly Announced[];
  readonly rootEnds: readonly Announced[];
  readonly rootErrors: readonly Announced[];
}

/** Every child end and failure heard, and every root's. */
export const heard = (): Heard => ({
  childEnds: childrenIn(endOnceSeen.ends),
  childErrors: childrenIn(endOnceSeen.errors),
  rootEnds: rootsIn(endOnceSeen.ends),
  rootErrors: rootsIn(endOnceSeen.errors),
});

/** The root's end or failure, wherever it was heard. */
export const rootEnded = (): boolean =>
  rootsIn(endOnceSeen.ends).length + rootsIn(endOnceSeen.errors).length > 0;

/**
 * The parent runs on `a`; its child passes the gate and ends; at the child's first announcement `a`
 * freezes (its lease store and timers) before its step is checkpointed; another instance takes the
 * tree over and ends it; then `a` thaws. What `a`'s call ended with.
 */
export async function frozenAfterChildEnd(
  a: TestApp,
  { clock, leases }: Fixtures,
  call: Promise<unknown>,
): Promise<unknown> {
  await until(() => yieldSeen.runs.length === 1, "the child at its gate");
  endOnceSeen.onChildEnd = once(() => {
    leases.stall(a);
  });
  openGate();
  await until(
    () => heard().childEnds.length + heard().childErrors.length > 0,
    "the child's end heard",
  );
  await liveFor(clock, 7);
  await until(rootEnded, "the tree ended where it was taken over");
  // the old holder thaws after the new holder finished
  leases.resume(a);
  const error = await rejectionOf(call);
  await settle();
  return error;
}
