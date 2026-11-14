import { pauseKeyOf } from "../../infrastructure/pause-record.js";
import type { FaultCluster } from "./cluster.js";
import { FaultWaitError } from "./pod.js";

/**
 * Before a run's facts are read (#940): a tree that ended has had its pauses closed, and their
 * notices are delivered after the change, not awaited by it — so the run waits, up to a limit, for
 * the fixture's listener to have told the test `opened` and `closed` of every pause a rest listed
 * for a root that ended. A notice that never comes is then the invariant's to report, not a race.
 */

/** The keys of the pauses a rest listed for a root whose end was heard. */
function closedPauseKeys(cluster: FaultCluster): readonly string[] {
  const ended = new Map(
    cluster.events
      .filter((event) => event.type === "end")
      .map((event) => [String(event.rootExecutionId), String(event.tenantId)] as const),
  );
  return cluster.events.flatMap((event) => {
    const tenantId = ended.get(String(event.executionId));
    if (event.type !== "finished" || tenantId === undefined || !Array.isArray(event.pauseIds))
      return [];
    return event.pauseIds.map((pauseId) => pauseKeyOf(tenantId, String(pauseId)));
  });
}

/** Whether the listener told `opened` and `closed` of the pause. */
const isTold = (cluster: FaultCluster, key: string): boolean =>
  ["opened", "closed"].every((notice) =>
    cluster.events.some(
      (event) => event.type === "pause-notice" && event.pauseKey === key && event.notice === notice,
    ),
  );

/** Waits (bounded, as every wait of the cluster is) until every pause of an ended tree was told. */
export async function settleNotices(cluster: FaultCluster): Promise<void> {
  try {
    await cluster.until("every closed pause told to its listener", () =>
      closedPauseKeys(cluster).every((key) => isTold(cluster, key)),
    );
  } catch (error) {
    // a notice that never came is the invariant's to report, with every event, not a timeout's
    if (!(error instanceof FaultWaitError)) throw error;
  }
}
