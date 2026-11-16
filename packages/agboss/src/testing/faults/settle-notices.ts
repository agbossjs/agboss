import { systemClock } from "../../infrastructure/clock.js";
import type { FaultCluster } from "./cluster.js";
import type { FaultRun } from "./facts.js";
import { heardOf, pausesOf } from "./invariants/pause-notices.js";
import type { FaultPod } from "./pod.js";
import { seconds } from "../../units/index.js";

/**
 * Before a run's facts are judged (#940): a tree that ended has had its pauses closed, and their
 * notices are delivered after the change, not awaited by it — so the run waits, up to a limit, for
 * the fixture's listener to have told the test `opened` and `closed` of every pause the notice
 * invariant will check: the pauses of every tree that ended — at a finish or at a failure, a
 * cancel's included (#1178) — that a rest listed AND the ones only its record lists, such as the
 * replacement of a reassignment, created while the tree rests (#1191). The wait reads the same facts
 * the invariant reads and asks the invariant's own `pausesOf` which pauses they are, so the two
 * cannot drift apart. A notice that never comes within the scenario's bound is then the invariant's
 * to report, not a race.
 */

/** How long the wait lets the store and the listener go between two reads. */
const LOOK_EVERY = seconds(0.05);

/** Whether the listener told `opened` and `closed` of the pause. */
const isTold = (run: FaultRun, key: string): boolean => {
  const heard = heardOf(run, key);
  return ["opened", "closed"].every((notice) => heard.some((one) => one.notice === notice));
};

/** The pauses the invariant checks that the listener has not yet told both notices of. */
const untold = (run: FaultRun): readonly string[] =>
  pausesOf(run)
    .map((pause) => pause.key)
    .filter((key) => !isTold(run, key));

/**
 * Waits (bounded, as every wait of the cluster is) until every pause of an ended tree was told, and
 * gives the facts it judged by: the invariant is to read these, not a later read that could list a
 * pause the wait never looked at.
 */
export async function settledRun(cluster: FaultCluster, reader: FaultPod): Promise<FaultRun> {
  const deadline = systemClock.now().getTime() + cluster.waitTimeout;
  for (;;) {
    const run = await cluster.run(reader);
    // a notice that never came is the invariant's to report, with every event, not a timeout's
    if (untold(run).length === 0 || systemClock.now().getTime() >= deadline) return run;
    await systemClock.sleep(LOOK_EVERY);
  }
}
