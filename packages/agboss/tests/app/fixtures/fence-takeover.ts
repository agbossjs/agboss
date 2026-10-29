import type { TestLeases, VirtualClock } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { ends } from "../../infrastructure/fixtures/recovery.workflow.js";
import { frozenRelease, levers, ReleaseWorkflowStart } from "./fence.workflow.js";

/** #471 — the takeover of a stalled writer, on any of the test applications that run the release. */

/** The instance `index` of a test with several. */
export const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** Lets the pending promise callbacks run (no clock involved). */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** What a call rejected with (`undefined` when it resolved). */
export const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

/**
 * A's release frozen inside its TOCTOU window — after `fence.assertHeld()`, before the ledger's
 * write — and its lease stalled; the clock moves past the lease and B's sweep, so B recovers the
 * tree under token 2 and writes. Its call, still waiting (in an object: an awaited promise would wait for it).
 */
export async function takenOver(
  apps: readonly TestApp[],
  clock: VirtualClock,
  leases: TestLeases,
): Promise<{ readonly call: Promise<unknown> }> {
  levers.freeze = true;
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  const frozen = frozenRelease();
  const call = execute(a, ReleaseWorkflowStart, { text: "v1" });
  call.catch(() => undefined);
  await frozen;
  leases.stall(a);
  // A's timers do not fire: its lease neither renews nor expires here, B's sweep takes it
  await clock.advance(seconds(31));
  await clock.advance(seconds(31));
  await ends(1);
  return { call };
}
