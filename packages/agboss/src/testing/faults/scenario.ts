import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { faultViolationsOf } from "./invariants/check.js";
import { FaultInvariantError } from "./invariants/violations.js";
import type { FaultRun } from "./facts.js";
import type { FaultPod } from "./pod.js";
import { FaultWorld, type FaultDatabase } from "./world.js";

/**
 * One fault scenario (#484): what it injects, written against a world of pods; it returns the
 * pod that reads the facts at its end (a live one). `runFaultScenario` resets the database, runs
 * it, reads the facts and checks every invariant on them — then kills whatever still runs.
 */

/** A fault scenario. */
export interface FaultScenario {
  /** Its id: `s05-zombie-write-refused` — what `faultSuite({ scenarios })` selects. */
  readonly id: string;
  /** Its test's name. */
  readonly title: string;
  /** The scenario itself: its pods, its faults, its own expectations; the reader at its end. */
  readonly run: (world: FaultWorld) => Promise<FaultPod>;
}

/** What one scenario runs on. */
export interface FaultScenarioOptions {
  /** The store set's module (an absolute path or a file URL): it exports `faultStores`. */
  readonly stores: string;
  readonly database: FaultDatabase;
  /** How much faster than real time every pod's clock runs; default 1 (the real clock). */
  readonly timeScale?: number;
  /**
   * How fast the store decides a lease's time runs (#533, the linearizability checker reads the
   * history by it): 1 for a database that decides by its own clock (`clock_timestamp()`); default
   * `timeScale`, the pods' — the time an in-memory or SQLite store decides by.
   */
  readonly storeTimeScale?: number;
}

/** A scenario's own expectations that did not hold, or a wait that ran past its deadline. */
export class FaultScenarioFailedError extends Error {
  override name = "FaultScenarioFailedError";
}

/** A live pod to read the facts with when a scenario stopped early: the last one started. */
const anyLivePod = (world: FaultWorld): FaultPod | undefined =>
  world.pods.findLast((pod) => pod.isRunning);

/**
 * The scenario run and its facts checked: the invariants first — also when the scenario stopped
 * early, on what a live pod reads then —, then the scenario's own expectations.
 */
async function checkedRun(scenario: FaultScenario, world: FaultWorld): Promise<FaultRun> {
  let reader: FaultPod | undefined;
  let stopped: Error | undefined;
  try {
    reader = await scenario.run(world);
  } catch (error) {
    stopped = error instanceof Error ? error : new Error(JSON.stringify(error));
    reader = anyLivePod(world);
  }
  if (reader === undefined) throw stopped ?? new Error(`${scenario.id} gave no pod to read with`);
  const run = await world.run(reader);
  const violations = faultViolationsOf(run);
  const notes = [...world.expectations, ...(stopped === undefined ? [] : [String(stopped)])];
  if (violations.length > 0) throw new FaultInvariantError(scenario.id, violations, notes);
  if (stopped !== undefined) throw stopped;
  if (notes.length > 0) throw new FaultScenarioFailedError(`${scenario.id}: ${notes.join("; ")}`);
  return run;
}

/** The variable naming a folder a failed scenario's events and history are written to (CI's artifact). */
export const FAULT_DUMP_VARIABLE = "AGBOSS_FAULT_DUMP_DIR";

/** Writes a failed run's pod events, history and pods' output to `$AGBOSS_FAULT_DUMP_DIR/<id>.json`. */
function dumped(scenario: FaultScenario, world: FaultWorld): void {
  const dir = process.env[FAULT_DUMP_VARIABLE];
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  const pods = world.pods.map((pod) => ({
    name: pod.name,
    instanceId: pod.instanceId,
    output: pod.output,
  }));
  const dump = { events: world.events, history: world.history.events, pods };
  writeFileSync(join(dir, `${scenario.id}.json`), JSON.stringify(dump, null, 2));
}

/** Runs `scenario` and checks the invariants; its run's facts when every one held. */
export async function runFaultScenario(
  scenario: FaultScenario,
  options: FaultScenarioOptions,
): Promise<FaultRun> {
  await options.database.reset?.();
  const world = new FaultWorld({
    stores: options.stores,
    database: options.database,
    timeScale: options.timeScale ?? 1,
    ...(options.storeTimeScale === undefined ? {} : { storeTimeScale: options.storeTimeScale }),
  });
  try {
    return await checkedRun(scenario, world);
  } catch (error) {
    dumped(scenario, world);
    throw error;
  } finally {
    await world.close();
  }
}
