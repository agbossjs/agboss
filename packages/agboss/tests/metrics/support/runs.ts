import type { VirtualClock } from "../../../src/testing/clock.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { settle } from "../../app/fixtures/fence-takeover.js";

/** #485 — driving a test's runs: its first instance, the clock until a call settles. */

export const first = (apps: readonly TestApp[]): TestApp => {
  const [app] = apps;
  if (app === undefined) throw new Error("the test runs no instance");
  return app;
};

/** Whether `call` has settled, read at any time. */
export function watched(call: Promise<unknown>): { readonly isSettled: () => boolean } {
  let isSettled = false;
  const settled = (): void => {
    isSettled = true;
  };
  void call.then(settled, settled);
  return { isSettled: () => isSettled };
}

/**
 * Advances the clock a second at a time until `call` settles (a jump past the lease would be a
 * frozen holder, #511); `look` runs before each second while it has not.
 */
export async function untilSettled(
  call: Promise<unknown>,
  clock: VirtualClock,
  look: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const progress = watched(call);
  for (let second = 0; second < 300 && !progress.isSettled(); second += 1) {
    await settle();
    if (progress.isSettled()) break;
    await look();
    await clock.advance(seconds(1));
  }
  await call;
  await settle();
}
