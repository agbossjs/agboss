import { systemClock } from "../../../infrastructure/clock.js";
import type { ContractTarget } from "../seam.js";
import { enabledActions, isSameAction } from "./enabled.js";
import { ExplorerRun, describe, type RanStep } from "./run.js";
import type { ExplorerAction, ExplorerStores, ExplorerViolation, ExplorerWorld } from "./types.js";

/**
 * The scheduler's search (#533 item 1): every schedule up to a depth, each state explored once
 * (exhaustive, for a few instances and steps), or seeded random walks (for more); each schedule
 * replayed from an empty store. A schedule that breaks an invariant is cut down to a minimal one
 * — every step whose removal keeps the violation removed — and printed. A search, a replay and the
 * cutting down stop with the budget (#590, #618): no store call once its case was aborted.
 */

/** A schedule and what it broke. */
export interface FoundViolation {
  readonly world: ExplorerWorld;
  readonly steps: readonly RanStep[];
  readonly violation: ExplorerViolation;
  /** The schedule the search found, before it was cut down. */
  readonly foundLength: number;
  readonly seed?: number;
  /** Why the schedule was not cut down (#618): its case was aborted or out of time meanwhile. */
  readonly unshrunk?: string;
}

/** What a search did. */
export interface SearchReport {
  readonly schedules: number;
  readonly states: number;
  readonly violation?: FoundViolation;
  /** Set when the search stopped before it was done (#590): how much was left, and why. */
  readonly stopped?: { readonly left: number; readonly reason: string };
}

/**
 * When a search must stop (#590): its case's signal (aborted when vitest times the case out — a
 * search left running would keep resetting the store under the next case) and a deadline on the
 * real clock (ms). A search that stops says so; it never reports a partial search as a whole one.
 */
export interface SearchBudget {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
}

/** Why `budget` says stop now, or nothing. */
export function stopReasonOf(budget: SearchBudget): string | undefined {
  if (budget.signal?.aborted === true) return "its case was aborted (timed out or cancelled)";
  if (budget.deadline !== undefined && systemClock.now().getTime() >= budget.deadline)
    return "it reached its time limit";
  return undefined;
}

/** `actions` replayed on a new run: an action no longer enabled is skipped; none once aborted. */
export async function replayed(
  world: ExplorerWorld,
  target: ContractTarget<ExplorerStores>,
  actions: readonly ExplorerAction[],
  budget: SearchBudget = {},
): Promise<ExplorerRun> {
  const run = await ExplorerRun.open(world, target);
  try {
    for (const action of actions) {
      if (run.observer.violations.length > 0 || budget.signal?.aborted === true) break;
      if (enabledActions(run).some((enabled) => isSameAction(enabled, action)))
        await run.step(action);
    }
  } finally {
    await run.close();
  }
  return run;
}

/** A schedule cut down, or why the cutting stopped (#618): the budget says stop. */
type Shrunk = { readonly run: ExplorerRun } | { readonly stopped: string };

/** `actions` cut down: each step whose removal still breaks `violation`'s invariant removed. */
async function shrunk(
  found: { readonly world: ExplorerWorld; readonly target: ContractTarget<ExplorerStores> },
  actions: readonly ExplorerAction[],
  violation: ExplorerViolation,
  budget: SearchBudget,
): Promise<Shrunk> {
  const { world, target } = found;
  let kept = [...actions];
  for (let at = kept.length - 1; at >= 0; at -= 1) {
    const stopped = stopReasonOf(budget);
    if (stopped !== undefined) return { stopped };
    const without = [...kept.slice(0, at), ...kept.slice(at + 1)];
    const run = await replayed(world, target, without, budget);
    if (run.observer.violations.some((one) => one.invariant === violation.invariant))
      kept = without;
  }
  const stopped = stopReasonOf(budget);
  if (stopped !== undefined) return { stopped };
  const run = await replayed(world, target, kept, budget);
  // a deadline lets a replay run whole; an abort cuts it short
  return budget.signal?.aborted === true ? { stopped: stopReasonOf(budget) ?? "" } : { run };
}

/** What a search found: the run that broke an invariant, of `actions`. */
interface Found {
  readonly world: ExplorerWorld;
  readonly target: ContractTarget<ExplorerStores>;
  readonly run: ExplorerRun;
  readonly actions: readonly ExplorerAction[];
  readonly violation: ExplorerViolation;
}

/** The violation `found`, cut down — or as found when the budget stopped the cutting (#618). */
async function cutDown(found: Found, budget: SearchBudget, seed?: number): Promise<FoundViolation> {
  const cut = await shrunk(found, found.actions, found.violation, budget);
  const minimal = "run" in cut ? cut.run : found.run;
  const first = minimal.observer.violations.find(
    (one) => one.invariant === found.violation.invariant,
  );
  return {
    world: found.world,
    steps: minimal.steps,
    violation: first ?? found.violation,
    foundLength: found.actions.length,
    ...(seed === undefined ? {} : { seed }),
    ...("stopped" in cut ? { unshrunk: cut.stopped } : {}),
  };
}

/**
 * Every schedule of `world` up to `depth` steps, breadth first — so each state is expanded once, at
 * the fewest steps that reach it — and the first violation.
 */
export async function exhaustive(
  world: ExplorerWorld,
  target: ContractTarget<ExplorerStores>,
  depth: number,
  budget: SearchBudget = {},
): Promise<SearchReport> {
  const seen = new Set<string>();
  const pending: ExplorerAction[][] = [[]];
  let schedules = 0;
  for (let prefix = pending.shift(); prefix !== undefined; prefix = pending.shift()) {
    const reason = stopReasonOf(budget);
    if (reason !== undefined)
      return { schedules, states: seen.size, stopped: { left: pending.length + 1, reason } };
    const run = await replayed(world, target, prefix, budget);
    schedules += 1;
    const violation = run.observer.violations[0];
    if (violation !== undefined) {
      const cut = await cutDown({ world, target, run, actions: prefix, violation }, budget);
      return { schedules, states: seen.size, violation: cut };
    }
    const isNew = !seen.has(run.key);
    seen.add(run.key);
    if (isNew && prefix.length < depth)
      for (const action of enabledActions(run)) pending.push([...prefix, action]);
  }
  return { schedules, states: seen.size };
}

/** A small seeded generator (mulberry32): the same seed, the same walks. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** `runs` random walks of `depth` steps from `seed`; the first violation. */
export async function randomWalks(
  world: ExplorerWorld,
  target: ContractTarget<ExplorerStores>,
  options: { readonly runs: number; readonly depth: number; readonly seed: number },
  budget: SearchBudget = {},
): Promise<SearchReport> {
  const random = seededRandom(options.seed);
  for (let walk = 0; walk < options.runs; walk += 1) {
    const reason = stopReasonOf(budget);
    if (reason !== undefined)
      return { schedules: walk, states: 0, stopped: { left: options.runs - walk, reason } };
    const run = await ExplorerRun.open(world, target);
    const actions: ExplorerAction[] = [];
    try {
      for (let step = 0; step < options.depth && run.observer.violations.length === 0; step += 1) {
        if (budget.signal?.aborted === true) break;
        const enabled = enabledActions(run);
        const action = enabled[Math.floor(random() * enabled.length)];
        if (action === undefined) break;
        actions.push(action);
        await run.step(action);
      }
    } finally {
      await run.close();
    }
    const violation = run.observer.violations[0];
    if (violation !== undefined) {
      const found = { world, target, run, actions, violation };
      return {
        schedules: walk + 1,
        states: 0,
        violation: await cutDown(found, budget, options.seed),
      };
    }
  }
  return { schedules: options.runs, states: 0 };
}

/** The printed minimal schedule of a violation. */
export function scheduleText(name: string, found: FoundViolation): string {
  const lines = found.steps.map(
    (step, at) => `  ${String(at + 1).padStart(2)}. ${describe(step.action)} ${step.label}`,
  );
  const seed = found.seed === undefined ? "exhaustive search" : `seed ${String(found.seed)}`;
  return [
    `interleaving explorer (${name}, ${found.world.kind} world, ${String(found.world.instances)} instances, ${seed}): [${found.violation.invariant}] ${found.violation.message}`,
    found.unshrunk === undefined
      ? `minimal schedule (${String(found.steps.length)} of the ${String(found.foundLength)} steps found):`
      : `schedule as found (${String(found.steps.length)} steps, not shrunk: ${found.unshrunk}):`,
    ...lines,
  ].join("\n");
}
