import type { FencedEffectKey } from "../../../infrastructure/fenced-effect.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRepository,
} from "../../../infrastructure/outbound-call.repository.js";
import type { ExecutionLease } from "../../../infrastructure/execution-lease.repository.js";
import { callKeyOf } from "./calls.js";
import { effectKeyOf } from "./moves.js";
import {
  epochOf,
  expectEqual,
  live,
  taken,
  type ForcedRace,
  type RaceAnswers,
  type RaceState,
} from "./races.js";
import type { ExplorerRun } from "./run.js";
import { ExplorerWorldKind } from "./types.js";

/**
 * AC7's races of the fenced effect and the outbound call (#533): the old holder's write against
 * the hand-over, and every compare-and-set of an intent — in both orders, the first call winning.
 */

/** The rows of the step's fenced effect. */
const rowsOf = async (run: ExplorerRun): Promise<number> =>
  ((await run.storesOf(1).rows?.committed()) ?? []).filter((row) => row.startsWith("race:")).length;

const writeBy = (run: ExplorerRun, instance: number, token: number): Promise<unknown> => {
  const { effects, rows } = run.storesOf(instance);
  if (effects === undefined || rows === undefined) throw new TypeError("no fenced-effect store");
  const row = `race:instance-${String(instance)}`;
  return effects
    .saveResultIfAbsent(effectKeyOf("tree-1", token), (transaction) => {
      const inserted = rows.insert(transaction, row);
      return inserted === undefined ? row : inserted.then(() => row);
    })
    .then((outcome) => outcome.status);
};

/** The hand-over: the holder releases, the other instance takes the tree and writes the effect. */
const handOver = async (run: ExplorerRun, { lease }: RaceState): Promise<unknown> => {
  await run.storesOf(1).leases.release(lease);
  const next = await taken(run, 2);
  return writeBy(run, 2, next.leaseEpoch);
};

/** The fenced effect's race (#500): the old holder's write against the hand-over. */
export const EFFECT_RACES: readonly ForcedRace[] = [
  {
    name: "a write against its lease's hand-over and the new holder's write (#500)",
    kind: ExplorerWorldKind.FencedEffect,
    setup: live,
    first: (run, { lease }) => writeBy(run, 1, lease.leaseEpoch),
    second: handOver,
    firstWins: async ({ first, second }, run) =>
      expectEqual("the old holder's write", first, "ran") ??
      expectEqual("the new holder's write", second, "replayed") ??
      expectEqual("the rows", await rowsOf(run), 1),
    secondWins: async ({ first, second }, run) =>
      expectEqual("the old holder's write", first, "fenced") ??
      expectEqual("the new holder's write", second, "ran") ??
      expectEqual("the rows", await rowsOf(run), 1),
  },
];

/** A first attempt's intent of `tree`'s execution. */
const raceIntent = (tree: string) => ({
  rootExecutionId: tree,
  executionId: tree,
  workflow: "explored-workflow",
  target: "payments",
  operation: "charge",
  idempotencyKey: "default:order%3A1:charge",
  request: "{}",
  attempt: 1,
  attemptOwner: `owner-${tree}`,
  step: { nodeId: "charge-action", visitNumber: 1 },
});

const PENDING = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" };

/** The first instance's lease with its call recorded pending (attempt 1 of owner-1). */
const recorded = async (run: ExplorerRun): Promise<RaceState> => {
  const lease = await taken(run, 1);
  const calls = run.storesOf(1).calls;
  if (calls === undefined) throw new TypeError("no outbound-call store");
  const key = callKeyOf("tree-1", lease.leaseEpoch);
  const intent = { ...raceIntent("tree-1"), attemptOwner: "owner-1" };
  if (!(await calls.saveIfAbsent(key, intent))) throw new Error("the intent was recorded before");
  return { lease };
};

/** A call store operation of `instance` on the first instance's key. */
const onKey = (
  run: ExplorerRun,
  instance: number,
  lease: ExecutionLease,
): { readonly calls: OutboundCallRepository; readonly key: FencedEffectKey } => {
  const calls = run.storesOf(instance).calls;
  if (calls === undefined) throw new TypeError("no outbound-call store");
  return { calls, key: callKeyOf("tree-1", lease.leaseEpoch) };
};

const moveBy = (run: ExplorerRun, instance: number, lease: ExecutionLease): Promise<unknown> => {
  const { calls, key } = onKey(run, instance, lease);
  return calls.markPending(key, PENDING, {
    attempt: 2,
    attemptOwner: `owner-${String(instance)}-2`,
  });
};

/** The owner of the intent after the race. */
const ownerOf = async (run: ExplorerRun, lease: ExecutionLease): Promise<unknown> => {
  const { calls, key } = onKey(run, 1, lease);
  return (await calls.findByKey(key))?.attemptOwner;
};

const winner = (answers: RaceAnswers, first: boolean): string | undefined =>
  expectEqual("the winner", answers.first, first) ??
  expectEqual("the loser", answers.second, !first);

/** The outbound call's compare-and-sets (#508): exactly the first one wins, in each order. */
export const CALL_RACES: readonly ForcedRace[] = [
  {
    name: "two claims of the next attempt from one read (#508)",
    kind: ExplorerWorldKind.OutboundCall,
    setup: recorded,
    first: (run, { lease }) => moveBy(run, 1, lease),
    second: (run, { lease }) => moveBy(run, 2, lease),
    firstWins: async (answers, run, { lease }) =>
      winner(answers, true) ?? expectEqual("the owner", await ownerOf(run, lease), "owner-1-2"),
    secondWins: async (answers, run, { lease }) =>
      winner(answers, false) ?? expectEqual("the owner", await ownerOf(run, lease), "owner-2-2"),
  },
  ...(["markCompleted", "markFailed"] as const).map((ending): ForcedRace => ({
    name: `${ending} of an attempt against a newer attempt's claim (#508)`,
    kind: ExplorerWorldKind.OutboundCall,
    setup: recorded,
    first: (run, { lease }) => {
      const { calls, key } = onKey(run, 1, lease);
      return ending === "markCompleted"
        ? calls.markCompleted(key, "owner-1", '"paid"')
        : calls.markFailed(key, "owner-1", {
            name: "DeclinedError",
            code: "DeclinedError",
            message: "declined",
          });
    },
    second: (run, { lease }) => moveBy(run, 2, lease),
    firstWins: async (answers, run, { lease }) =>
      winner(answers, true) ?? expectEqual("the owner", await ownerOf(run, lease), "owner-1"),
    secondWins: async (answers, run, { lease }) =>
      winner(answers, false) ?? expectEqual("the owner", await ownerOf(run, lease), "owner-2-2"),
  })),
  {
    name: "two executions recording one business key (#508)",
    kind: ExplorerWorldKind.OutboundCall,
    isTwoTrees: true,
    setup: live,
    first: (run, { lease }) =>
      onKey(run, 1, lease).calls.saveIfAbsent(
        callKeyOf("tree-1", lease.leaseEpoch),
        raceIntent("tree-1"),
      ),
    second: async (run: ExplorerRun): Promise<unknown> => {
      const other = await taken(run, 2, "tree-2");
      return onKey(run, 2, other).calls.saveIfAbsent(
        callKeyOf("tree-2", other.leaseEpoch),
        raceIntent("tree-2"),
      );
    },
    firstWins: (answers) => Promise.resolve(winner(answers, true)),
    secondWins: (answers) => Promise.resolve(winner(answers, false)),
  },
  {
    name: "a claim against its lease's hand-over (#508)",
    kind: ExplorerWorldKind.OutboundCall,
    setup: recorded,
    first: (run, { lease }) => moveBy(run, 1, lease),
    second: async (run: ExplorerRun, { lease }: RaceState): Promise<unknown> => {
      await run.storesOf(1).leases.release(lease);
      return epochOf(await taken(run, 2));
    },
    firstWins: (answers) => Promise.resolve(expectEqual("the claim", answers.first, true)),
    secondWins: (answers) => Promise.resolve(expectEqual("the claim", answers.first, "fenced")),
  },
];
