import { CostSource, ZERO_USAGE, type UsageRecord } from "../finops/usage.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ExecutionTreeRepository } from "../infrastructure/execution-tree.repository.js";
import type { AppDeps } from "./app-deps.js";
import { executionEventAt } from "./run-events.js";
import { treeOf, WITHOUT_RECOVERY_KEY } from "./tree-ends.js";
import type { TreeState } from "./tree-move-types.js";

/**
 * The lost pass of a run no recovery continues (#860 D1, as #853 records a lost pass): an instance
 * that takes its lease over ends it without a pass, so its holder's pass was lost mid-run — for a
 * run that can call a model, one call of unknown cost, no amount (`CostSource.Unknown`), in the
 * spend of its kept record (`spend.unknownCalls`, what `agboss records export` writes) and counted
 * by the instance's tally, under the run's own ledger key: one per run, whoever ends it. No budget
 * counter is written: the amount is none, and a budget's `maxSpend()` is read inside an execution
 * only.
 */

/** The ledger id of a lost run's call of unknown cost: one per run, ever. */
export const lostRunLedgerIdOf = (state: Pick<TreeState, "tenantId" | "runId">): string =>
  `unknown:lost-run:${state.tenantId}:${state.runId}`;

/** The mark's word on models; a mark of another shape reads as one that can (fail closed). */
const callsModel = (mark: unknown): boolean =>
  !(typeof mark === "object" && mark !== null && Reflect.get(mark, "callsModel") === false);

/**
 * The call of unknown cost of a run no recovery continues whose lease was taken over, read before
 * its tree's keys go; none for any other tree, or a run that calls no model.
 */
export async function lostRunUsageOf(
  parts: {
    readonly deps: AppDeps;
    readonly trees: Pick<ExecutionTreeRepository, "findByIdInTree">;
    readonly clock: Clock;
  },
  state: TreeState,
): Promise<readonly UsageRecord[]> {
  const { deps, trees, clock } = parts;
  const mark = await trees.findByIdInTree(treeOf(state), WITHOUT_RECOVERY_KEY);
  if (mark === undefined || !callsModel(mark)) return [];
  const workflow = executionEventAt(state, deps).workflow.name;
  const record: UsageRecord = {
    ...ZERO_USAGE,
    caller: `lost-pass:${workflow}`,
    model: "unknown",
    costUsd: 0,
    costSource: CostSource.Unknown,
    ledgerKey: { id: lostRunLedgerIdOf(state), madeAt: clock.now() },
  };
  return [record];
}

/** Counts a lost run's calls of unknown cost in the instance's tally, once its record is ended. */
export function tallyLostRun(deps: AppDeps, state: TreeState, usage: readonly UsageRecord[]): void {
  if (usage.length === 0) return;
  const workflow = executionEventAt(state, deps).workflow.name;
  deps.observer.unknownCosts?.recorded(workflow, usage.length);
}
