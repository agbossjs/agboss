import { expect, it } from "vitest";
import { runFaultScenario, type RunnableFaultScenario } from "../../src/testing/faults/scenario.js";
import { a2aCall, a2aPod } from "../../src/testing/faults/scenarios/a2a-kit.js";
import { expectThat, heldAt, holdStore, release } from "../../src/testing/faults/scenarios/kit.js";
import { canceledOnBoth, pausedTask } from "../../src/testing/faults/scenarios/s18-kit.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { A2ATaskState } from "../../src/infrastructure/a2a-task.repository.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #980 — scenario 18's `pausedTask` hands back a task whose first pass has let go of its lease. A
 * caller reads `INPUT_REQUIRED` while that pass still holds the lease (its rest is announced before
 * its release, #901): a follow-up sent then is taken by the first pass's drain, not by its own
 * resume, so a cancel that stops the drained pass ends the follow-up with `-32004` (18d's end), not
 * the acceptance 18 expects. Under load the window was wide enough to hit once in CI. The first
 * pass's release is held here: `pausedTask` must not return while it is.
 */
const resting: RunnableFaultScenario = {
  id: "s18-rest-before-follow-up",
  title: "pausedTask returns only once the first pass released the lease",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a");
    await holdStore(a, StoreHoldPoint.LeaseRelease, undefined);
    let isReturned = false;
    const paused = pausedTask(cluster, a, "o-18r").then((taskId) => {
      isReturned = true;
      return taskId;
    });
    const held = await heldAt(cluster, a, StoreHoldPoint.LeaseRelease);
    // the rest is visible to a caller while the release is held: the read that saw it was answered
    await cluster.next(
      "INPUT_REQUIRED told to a caller",
      (event) => event.type === "a2a-answer" && event.state === A2ATaskState.InputRequired,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expectThat(cluster, !isReturned, "pausedTask returned while the first pass held its lease");
    await release(a, held);
    const taskId = await paused;
    await a2aCall(cluster, a, "CancelTask", { id: taskId });
    await canceledOnBoth(cluster, [a], taskId);
    return a;
  },
};

it("#980: a task handed back by pausedTask has no pass holding its lease", async () => {
  await expect(runFaultScenario(resting, sqliteFaultTarget())).resolves.toBeDefined();
}, 120_000);
