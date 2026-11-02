import { describe, expect, it, type TestContext } from "vitest";
import { isOptedOutStore, optedOutRefusal, OPTED_OUT_REASON } from "../fencing-gate.js";
import type { FencedEffectStores } from "../fenced-effect-data.js";
import type { OutboundCallStores } from "../outbound-call-data.js";
import type { ExecutionLeaseRepository } from "../../../infrastructure/execution-lease.repository.js";
import type { ContractTarget } from "../seam.js";
import { LEASE_RACES, raced, type ForcedRace } from "./races.js";
import { CALL_RACES, EFFECT_RACES } from "./store-races.js";
import { ExplorerRun } from "./run.js";
import { exhaustive, randomWalks } from "./search.js";
import { budgetOf, expectComplete, InterleavingViolationError, timeoutOf } from "./outcomes.js";
import { ExplorerWorldKind, type ExplorerStores } from "./types.js";
import {
  CALL_SKEWS,
  callTarget,
  effectTarget,
  leaseTarget,
  EXPLORED_SKEWS,
  skewText,
  worldOf,
} from "./worlds.js";

/**
 * `interleavings (<name>)` (#533 item 1): the explorer's cases for a store set, registered by
 * `storeConformance` — every schedule of two instances up to a depth in each world and with each
 * skew of the second instance's clock, seeded random walks of three, and every two-outcome race in
 * both orders (AC7). A failure prints the minimal schedule.
 */

/** How far the explorer looks. */
export interface InterleavingOptions {
  /** The steps of the exhaustive search of two instances; default 8. */
  readonly depth?: number;
  /** The random walks of three instances; default 200. */
  readonly walks?: number;
  /** The steps of each walk; default 30. */
  readonly walkDepth?: number;
  /** The walks' seed; default `AGBOSS_EXPLORER_SEED` or 533. */
  readonly seed?: number;
  /**
   * How long one case may search, in ms of real time (#590); default 8 minutes. A search still
   * going then stops and fails the case with what it explored and what was left — never a pass.
   */
  readonly timeLimit?: number;
}

/** What `storeConformance` adds: whether the set accepted an opted-out store (#543). */
interface RegisterOptions extends InterleavingOptions {
  readonly isOptOutAccepted?: boolean;
}

/**
 * The fencing targets the explorer runs on. The lease store alone (#694: a set of coordination
 * stores, `without` its fenced-effect and outbound-call stores) is explored without `leaseStateOf`.
 */
export interface InterleavingTargets {
  readonly executionLease?: ContractTarget<ExecutionLeaseRepository> | undefined;
  readonly fencedEffect?: ContractTarget<FencedEffectStores<unknown>> | undefined;
  readonly outboundCall?: ContractTarget<OutboundCallStores> | undefined;
}

/** One explored world and the stores it runs on. */
interface WorldCase {
  readonly title: string;
  readonly kind: ExplorerWorldKind;
  readonly isBusinessKey: boolean;
  readonly target: ContractTarget<ExplorerStores>;
}

/**
 * The lease world's target: the outbound-call store's leases with `leaseStateOf`, else the lease
 * store alone (#694) — never nothing for a set with a lease store.
 */
function leaseWorldOf(targets: InterleavingTargets): WorldCase | undefined {
  if (targets.outboundCall !== undefined)
    return {
      title: "every lease operation and leaseStateOf",
      kind: ExplorerWorldKind.Lease,
      isBusinessKey: false,
      target: callTarget(targets.outboundCall),
    };
  if (targets.executionLease === undefined) return undefined;
  return {
    title: "every lease operation",
    kind: ExplorerWorldKind.Lease,
    isBusinessKey: false,
    target: leaseTarget(targets.executionLease),
  };
}

/** The worlds a set's targets give. */
function worldCases(targets: InterleavingTargets): WorldCase[] {
  const cases: WorldCase[] = [];
  const calls = targets.outboundCall === undefined ? undefined : callTarget(targets.outboundCall);
  const effects =
    targets.fencedEffect === undefined ? undefined : effectTarget(targets.fencedEffect);
  const leases = leaseWorldOf(targets);
  if (leases !== undefined) cases.push(leases);
  if (effects !== undefined)
    cases.push({
      title: "the step's fenced effect",
      kind: ExplorerWorldKind.FencedEffect,
      isBusinessKey: false,
      target: effects,
    });
  if (calls !== undefined) {
    cases.push({
      title: "an outbound call handed over on one tree",
      kind: ExplorerWorldKind.OutboundCall,
      isBusinessKey: false,
      target: calls,
    });
    cases.push({
      title: "an outbound call under one business key from two trees",
      kind: ExplorerWorldKind.OutboundCall,
      isBusinessKey: true,
      target: calls,
    });
  }
  return cases;
}

/**
 * The opt-out gate (#543): a world whose fencing store declares `LeaseCheck.WithoutDoubleChargeProtection`
 * never passes — refused unless the set accepted it, then skipped with the reason.
 */
async function isGated(
  world: Pick<WorldCase, "kind" | "target">,
  options: RegisterOptions,
  context: TestContext,
): Promise<void> {
  if (world.kind === ExplorerWorldKind.Lease) return;
  const run = await ExplorerRun.open(
    worldOf(world.kind, 1, EXPLORED_SKEWS[0] ?? never()),
    world.target,
  );
  await run.close();
  const store = run.storesOf(1).calls ?? run.storesOf(1).effects;
  if (store === undefined || !isOptedOutStore(store)) return;
  if (options.isOptOutAccepted !== true) throw optedOutRefusal(store);
  context.skip(OPTED_OUT_REASON);
}

const never = (): never => {
  throw new Error("no skew");
};

const DEFAULT_SEED = 533;
const TIMEOUT = 600_000;

/** The seed of the walks: the option, else `AGBOSS_EXPLORER_SEED`, else 533. */
const seedOf = (options: InterleavingOptions): number => {
  const fromEnvironment = Number(process.env.AGBOSS_EXPLORER_SEED ?? "");
  return (
    options.seed ??
    (Number.isInteger(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : DEFAULT_SEED)
  );
};

function registerWorld(name: string, world: WorldCase, options: RegisterOptions): void {
  const depth = options.depth ?? 8;
  const skews = world.kind === ExplorerWorldKind.Lease ? EXPLORED_SKEWS : CALL_SKEWS;
  it(
    `${world.title}: every schedule of 2 instances up to ${String(depth)} steps, the second's clock ${skews.map(skewText).join(", ")}`,
    async (context) => {
      await isGated(world, options, context);
      const budget = budgetOf(options, context.signal);
      for (const skew of skews) {
        const world2 = worldOf(world.kind, 2, skew, world.isBusinessKey);
        const what = `${world.title}, every schedule, the second's clock ${skewText(skew)}`;
        expectComplete(name, what, await exhaustive(world2, world.target, depth, budget));
      }
    },
    timeoutOf(options),
  );
  const walks = options.walks ?? 200;
  const walkDepth = options.walkDepth ?? 30;
  const seed = seedOf(options);
  it(
    `${world.title}: ${String(walks)} seeded walks of 3 instances, ${String(walkDepth)} steps each (seed ${String(seed)})`,
    async (context) => {
      await isGated(world, options, context);
      const budget = budgetOf(options, context.signal);
      for (const [at, skew] of skews.entries()) {
        const walk = { runs: walks, depth: walkDepth, seed: seed + at };
        const world3 = worldOf(world.kind, 3, skew, world.isBusinessKey);
        const what = `${world.title}, walks of seed ${String(seed + at)}, the second's clock ${skewText(skew)}`;
        expectComplete(name, what, await randomWalks(world3, world.target, walk, budget));
      }
    },
    timeoutOf(options),
  );
}

/** One race in both orders. */
function registerRace(
  race: ForcedRace,
  target: ContractTarget<ExplorerStores>,
  options: RegisterOptions,
): void {
  it(
    `AC7: ${race.name} — both orders forced, each with the outcome the contract gives it`,
    async (context) => {
      await isGated({ kind: race.kind, target }, options, context);
      const problems = [await raced(race, target, true), await raced(race, target, false)].filter(
        (one) => one !== undefined,
      );
      if (problems.length > 0)
        throw new InterleavingViolationError(`interleaving explorer: ${problems.join("\n")}`);
      expect(problems).toEqual([]);
    },
    TIMEOUT,
  );
}

/** Registers `interleavings (<name>)` for the targets a set has. */
export function registerInterleavings(
  name: string,
  targets: InterleavingTargets,
  options: RegisterOptions = {},
): void {
  const worlds = worldCases(targets);
  if (worlds.length === 0) return;
  describe(`interleavings (${name})`, () => {
    for (const world of worlds) registerWorld(name, world, options);
    const calls = targets.outboundCall === undefined ? undefined : callTarget(targets.outboundCall);
    const effects =
      targets.fencedEffect === undefined ? undefined : effectTarget(targets.fencedEffect);
    if (calls !== undefined)
      for (const race of [...LEASE_RACES, ...CALL_RACES]) registerRace(race, calls, options);
    else if (targets.executionLease !== undefined) {
      // #694: the races of the leases alone; those of leaseStateOf need the outbound-call store
      const leases = leaseTarget(targets.executionLease);
      for (const race of LEASE_RACES.filter((one) => one.kind === ExplorerWorldKind.Lease))
        registerRace(race, leases, options);
    }
    if (effects !== undefined)
      for (const race of EFFECT_RACES) registerRace(race, effects, options);
  });
}
