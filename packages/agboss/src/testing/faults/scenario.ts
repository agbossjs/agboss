import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { faultViolationsOf } from "./invariants/check.js";
import { FaultInvariantError } from "./invariants/violations.js";
import type { FaultRun } from "./facts.js";
import { FaultStoreTimeError, storeTimeScaleOf } from "./fault-stores.js";
import type { FaultPod } from "./pod.js";
import { FaultCluster, type FaultDatabase } from "./cluster.js";

/**
 * One fault scenario (#484): what it injects, written against a cluster of pods; it returns the
 * pod that reads the facts at its end (a live one). `runFaultScenario` resets the database, runs
 * it, reads the facts and checks every invariant on them — then kills whatever still runs.
 */

/** A fault scenario, as the suite names it (#831: what it runs is the suite's own). */
export interface FaultScenario {
  /** Its id: `s05-zombie-write-refused` — what `faultSuite({ scenarios })` selects. */
  readonly id: string;
  /** Its test's name. */
  readonly title: string;
}

/** A fault scenario and what it runs (internal): its pods, its faults, its own expectations. */
export interface RunnableFaultScenario extends FaultScenario {
  /** The scenario itself: its pods, its faults, its own expectations; the reader at its end. */
  readonly run: (cluster: FaultCluster) => Promise<FaultPod>;
}

/** What one scenario runs on. */
export interface FaultScenarioOptions {
  /**
   * The path of the store set's module (an absolute path or a file URL, #831: not the stores
   * themselves): it exports `faultStores`, which every pod imports.
   */
  readonly storesModule: string;
  readonly database: FaultDatabase;
  /**
   * How much faster than real time every pod's clock runs; default 1 (the real clock). The store's
   * time runs at it only for a set on the host's clock: the set says which (`FaultStoreSet.storeTime`,
   * #799).
   */
  readonly timeScale?: number;
}

/** A scenario's own expectations that did not hold, or a wait that ran past its deadline. */
export class FaultScenarioFailedError extends Error {
  override name = "FaultScenarioFailedError";
}

/** A live pod to read the facts with when a scenario stopped early: the last one started. */
const anyLivePod = (cluster: FaultCluster): FaultPod | undefined =>
  cluster.pods.findLast((pod) => pod.isRunning);

/**
 * The scenario run and its facts checked: the invariants first — also when the scenario stopped
 * early, on what a live pod reads then —, then the scenario's own expectations.
 */
async function checkedRun(scenario: RunnableFaultScenario, cluster: FaultCluster): Promise<FaultRun> {
  let reader: FaultPod | undefined;
  let stopped: Error | undefined;
  try {
    reader = await scenario.run(cluster);
  } catch (error) {
    stopped = error instanceof Error ? error : new Error(JSON.stringify(error));
    reader = anyLivePod(cluster);
  }
  if (reader === undefined) throw stopped ?? new Error(`${scenario.id} gave no pod to read with`);
  // the history read on the store's own time (#533), as its set declares it (#799): the
  // linearizability checker maps it so
  if (reader.storeTime === undefined) throw new FaultStoreTimeError(undefined);
  const timeScale = storeTimeScaleOf(reader.storeTime, cluster.options.timeScale);
  const run = { ...(await cluster.run(reader)), timeScale };
  const violations = faultViolationsOf(run);
  const notes = [...cluster.expectations, ...(stopped === undefined ? [] : [String(stopped)])];
  if (violations.length > 0) throw new FaultInvariantError(scenario.id, violations, notes);
  if (stopped !== undefined) throw stopped;
  if (notes.length > 0) throw new FaultScenarioFailedError(`${scenario.id}: ${notes.join("; ")}`);
  return run;
}

/** The variable naming a folder a failed scenario's events and history are written to (CI's artifact). */
export const FAULT_DUMP_VARIABLE = "AGBOSS_FAULT_DUMP_DIR";

/** Writes a failed run's pod events, history and pods' output to `$AGBOSS_FAULT_DUMP_DIR/<id>.json`. */
function dumped(scenario: RunnableFaultScenario, cluster: FaultCluster): void {
  const dir = process.env[FAULT_DUMP_VARIABLE];
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  const pods = cluster.pods.map((pod) => ({
    name: pod.name,
    instanceId: pod.instanceId,
    output: pod.output,
  }));
  const dump = { events: cluster.events, history: cluster.history.events, pods };
  writeFileSync(join(dir, `${scenario.id}.json`), JSON.stringify(dump, null, 2));
}

/** Runs `scenario` and checks the invariants; its run's facts when every one held. */
export async function runFaultScenario(
  scenario: RunnableFaultScenario,
  options: FaultScenarioOptions,
): Promise<FaultRun> {
  await options.database.reset?.();
  const cluster = new FaultCluster({
    storesModule: options.storesModule,
    database: options.database,
    timeScale: options.timeScale ?? 1,
  });
  try {
    return await checkedRun(scenario, cluster);
  } catch (error) {
    dumped(scenario, cluster);
    throw error;
  } finally {
    await cluster.close();
  }
}
