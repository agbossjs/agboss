import type { ContractTarget } from "../seam.js";
import { enabledActions, isSameAction } from "./enabled.js";
import { ExplorerRun, describe, type RanStep } from "./run.js";
import type { ExplorerAction, ExplorerStores, ExplorerViolation, ExplorerWorld } from "./types.js";

/**
 * The scheduler's search (#533 item 1): every schedule up to a depth, each state explored once
 * (exhaustive, for a few instances and steps), or seeded random walks (for more); each schedule
 * replayed from an empty store. A schedule that breaks an invariant is cut down to a minimal one
 * — every step whose removal keeps the violation removed — and printed.
 */

/** A schedule and what it broke. */
export interface FoundViolation {
  readonly world: ExplorerWorld;
  readonly steps: readonly RanStep[];
  readonly violation: ExplorerViolation;
  /** The schedule the search found, before it was cut down. */
  readonly foundLength: number;
  readonly seed?: number;
}

/** What a search did. */
export interface SearchReport {
  readonly schedules: number;
  readonly states: number;
  readonly violation?: FoundViolation;
}

/** `actions` replayed on a new run: an action no longer enabled is skipped. */
export async function replayed(
  world: ExplorerWorld,
  target: ContractTarget<ExplorerStores>,
  actions: readonly ExplorerAction[],
): Promise<ExplorerRun> {
  const run = await ExplorerRun.open(world, target);
  try {
    for (const action of actions) {
      if (run.observer.violations.length > 0) break;
      if (enabledActions(run).some((enabled) => isSameAction(enabled, action)))
        await run.step(action);
    }
  } finally {
    await run.close();
  }
  return run;
}

/** `actions` cut down: each step whose removal still breaks `violation`'s invariant removed. */
async function shrunk(
  world: ExplorerWorld,
  target: ContractTarget<ExplorerStores>,
  actions: readonly ExplorerAction[],
  violation: ExplorerViolation,
): Promise<ExplorerRun> {
  let kept = [...actions];
  for (let at = kept.length - 1; at >= 0; at -= 1) {
    const without = [...kept.slice(0, at), ...kept.slice(at + 1)];
    const run = await replayed(world, target, without);
    if (run.observer.violations.some((found) => found.invariant === violation.invariant))
      kept = without;
  }
  return replayed(world, target, kept);
}

/** The violation found by `run` (of `actions`), cut down. */
async function found(
  world: ExplorerWorld,
  target: ContractTarget<ExplorerStores>,
  actions: readonly ExplorerAction[],
  violation: ExplorerViolation,
  seed?: number,
): Promise<FoundViolation> {
  const minimal = await shrunk(world, target, actions, violation);
  const first = minimal.observer.violations.find((one) => one.invariant === violation.invariant);
  return {
    world,
    steps: minimal.steps,
    violation: first ?? violation,
    foundLength: actions.length,
    ...(seed === undefined ? {} : { seed }),
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
): Promise<SearchReport> {
  const seen = new Set<string>();
  const pending: ExplorerAction[][] = [[]];
  let schedules = 0;
  for (let prefix = pending.shift(); prefix !== undefined; prefix = pending.shift()) {
    const run = await replayed(world, target, prefix);
    schedules += 1;
    const violation = run.observer.violations[0];
    if (violation !== undefined)
      return {
        schedules,
        states: seen.size,
        violation: await found(world, target, prefix, violation),
      };
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
): Promise<SearchReport> {
  const random = seededRandom(options.seed);
  for (let walk = 0; walk < options.runs; walk += 1) {
    const run = await ExplorerRun.open(world, target);
    const actions: ExplorerAction[] = [];
    try {
      for (let step = 0; step < options.depth && run.observer.violations.length === 0; step += 1) {
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
    if (violation !== undefined)
      return {
        schedules: walk + 1,
        states: 0,
        violation: await found(world, target, actions, violation, options.seed),
      };
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
    `minimal schedule (${String(found.steps.length)} of the ${String(found.foundLength)} steps found):`,
    ...lines,
  ].join("\n");
}
