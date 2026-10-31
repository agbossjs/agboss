import type { ExecutionLease } from "../../../infrastructure/execution-lease.repository.js";
import { ClockSkew } from "../../clock-skew.js";
import type { ContractTarget } from "../seam.js";
import { ExplorerRun, isFenced } from "./run.js";
import {
  EXPLORED_LEASE,
  EXPLORED_TENANT,
  ExplorerWorldKind,
  type ExplorerStores,
  type ExplorerWorld,
} from "./types.js";

/**
 * AC7 (#533, from agbossjs/postgres#9): every race of the store contracts whose outcome depends on
 * which call the store takes first, run in both orders on every store — each call sent only once
 * the store answered the one before, never left to a free race (which on PostgreSQL only ever ran
 * one order of `finish` against a take). Each race names what each order must give.
 */

/** A two-outcome race: its setup, its two calls, what each order must end with. */
export interface ForcedRace {
  readonly name: string;
  readonly kind: ExplorerWorldKind;
  /** Whether the second instance works on a tree of its own (one business key, two trees). */
  readonly isTwoTrees?: boolean;
  readonly setup: (run: ExplorerRun) => Promise<RaceState>;
  readonly first: (run: ExplorerRun, state: RaceState) => Promise<unknown>;
  readonly second: (run: ExplorerRun, state: RaceState) => Promise<unknown>;
  /** What the two answers and the store must be, when `first` ran first: a problem or nothing. */
  readonly firstWins: (
    answers: RaceAnswers,
    run: ExplorerRun,
    state: RaceState,
  ) => Promise<string | undefined>;
  readonly secondWins: (
    answers: RaceAnswers,
    run: ExplorerRun,
    state: RaceState,
  ) => Promise<string | undefined>;
}

/** What the setup made: the first instance's lease. */
export interface RaceState {
  readonly lease: ExecutionLease;
}

/** The answers of the two calls, whichever ran first. */
export interface RaceAnswers {
  readonly first: unknown;
  readonly second: unknown;
}

/** A world of two instances on time. */
export const raceWorldOf = (race: ForcedRace): ExplorerWorld => ({
  kind: race.kind,
  instances: 2,
  treeOf: (instance) => (race.isTwoTrees === true && instance === 2 ? "tree-2" : "tree-1"),
  skewOf: () => ClockSkew.none,
});

/** An answer, or the fence's refusal as `"fenced"`; any other error is rethrown. */
const settled = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    (answer) => answer,
    (error: unknown) => {
      if (isFenced(error)) return "fenced";
      throw error;
    },
  );

/** Runs `race` in one order: setup, then one call, then the other; the problem, if any. */
export async function raced(
  race: ForcedRace,
  target: ContractTarget<ExplorerStores>,
  isFirstFirst: boolean,
): Promise<string | undefined> {
  const run = await ExplorerRun.open(raceWorldOf(race), target);
  try {
    const state = await race.setup(run);
    const a = isFirstFirst ? race.first : race.second;
    const b = isFirstFirst ? race.second : race.first;
    const earlier = await settled(a(run, state));
    const later = await settled(b(run, state));
    const answers = isFirstFirst
      ? { first: earlier, second: later }
      : { first: later, second: earlier };
    const problem = await (isFirstFirst ? race.firstWins : race.secondWins)(answers, run, state);
    if (problem === undefined) return undefined;
    const order = isFirstFirst
      ? "the first call, then the second"
      : "the second call, then the first";
    return `${race.name}, forced as ${order} (answered ${JSON.stringify(earlier)}, then ${JSON.stringify(later)}): ${problem}`;
  } finally {
    await run.close();
  }
}

/** A lease of `tree` taken by `instance`; the setup fails without it. */
export async function taken(
  run: ExplorerRun,
  instance: number,
  tree = "tree-1",
): Promise<ExecutionLease> {
  const lease = await run.storesOf(instance).leases.acquire(EXPLORED_TENANT, tree, EXPLORED_LEASE);
  if (lease === undefined) throw new Error(`instance-${String(instance)} could not take ${tree}`);
  return lease;
}

/** The first instance's lease, and the time moved to its end. */
export const expired = async (run: ExplorerRun): Promise<RaceState> => {
  const lease = await taken(run, 1);
  await run.clock.advance(EXPLORED_LEASE);
  return { lease };
};

export const live = async (run: ExplorerRun): Promise<RaceState> => ({
  lease: await taken(run, 1),
});

export const acquireBy2 = (run: ExplorerRun): Promise<unknown> =>
  run.storesOf(2).leases.acquire(EXPLORED_TENANT, "tree-1", EXPLORED_LEASE);

export const epochOf = (answer: unknown): number | undefined =>
  typeof answer === "object" && answer !== null ? (answer as ExecutionLease).leaseEpoch : undefined;

/** A problem unless `answer` is a lease of `epoch` (or, for `undefined`, a refusal). */
export const expectTake = (answer: unknown, epoch: number | undefined): string | undefined =>
  epochOf(answer) === epoch
    ? undefined
    : `the take answered ${JSON.stringify(answer)}, not ${epoch === undefined ? "a refusal" : `epoch ${String(epoch)}`}`;

export const expectEqual = (
  what: string,
  answer: unknown,
  expected: unknown,
): string | undefined =>
  JSON.stringify(answer) === JSON.stringify(expected)
    ? undefined
    : `${what} answered ${JSON.stringify(answer)}, not ${JSON.stringify(expected)}`;

const stateOf = (run: ExplorerRun, epoch: number): Promise<unknown> => {
  const calls = run.storesOf(2).calls;
  if (calls === undefined) throw new TypeError("no outbound-call store");
  return calls.leaseStateOf({
    tenantId: EXPLORED_TENANT,
    leaseExecutionId: "tree-1",
    token: epoch,
  });
};

/** The lease races (#520, #508): finish, release and `leaseStateOf` against a take, and each other. */
export const LEASE_RACES: readonly ForcedRace[] = [
  {
    name: "finish against another instance's take, past the lease (#520)",
    kind: ExplorerWorldKind.Lease,
    setup: expired,
    first: (run, { lease }) => run.storesOf(1).leases.finish(lease),
    second: acquireBy2,
    firstWins: ({ second }) => Promise.resolve(expectTake(second, undefined)),
    secondWins: ({ second }) => Promise.resolve(expectTake(second, 2)),
  },
  {
    name: "release against another instance's take of a live lease",
    kind: ExplorerWorldKind.Lease,
    setup: live,
    first: (run, { lease }) => run.storesOf(1).leases.release(lease),
    second: acquireBy2,
    firstWins: ({ second }) => Promise.resolve(expectTake(second, 2)),
    secondWins: ({ second }) => Promise.resolve(expectTake(second, undefined)),
  },
  {
    name: "leaseStateOf of an expired lease against another instance's take (#508)",
    kind: ExplorerWorldKind.OutboundCall,
    setup: expired,
    first: (run) => stateOf(run, 1),
    second: acquireBy2,
    firstWins: ({ first, second }) =>
      Promise.resolve(expectEqual("leaseStateOf", first, "superseded") ?? expectTake(second, 2)),
    secondWins: ({ first, second }) =>
      Promise.resolve(expectEqual("leaseStateOf", first, "ended") ?? expectTake(second, 2)),
  },
  {
    name: "finish against leaseStateOf, past the lease: finished either way",
    kind: ExplorerWorldKind.OutboundCall,
    setup: expired,
    first: (run, { lease }) => run.storesOf(1).leases.finish(lease),
    second: (run) => stateOf(run, 1),
    firstWins: async ({ second }, run) =>
      expectEqual("leaseStateOf", second, "ended") ?? expectTake(await acquireBy2(run), undefined),
    secondWins: async ({ second }, run) =>
      expectEqual("leaseStateOf", second, "superseded") ??
      expectTake(await acquireBy2(run), undefined),
  },
];
