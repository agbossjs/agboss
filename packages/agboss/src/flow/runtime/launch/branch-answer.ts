import type { RunnableConfig } from "@langchain/core/runnables";
import type { UsageRecord } from "../../../finops/usage.js";
import { compensationsOfBranch, type CompensationEntry } from "../../compensation.js";
import type { FrameSpec } from "../../context/frame.js";
import { withTaken } from "../compensation/held-entries.js";
import type { RuntimeNode } from "../graph-model.js";
import type { NodeOutcome } from "../node-runner.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "../state.js";
import type { BranchDeps } from "./branch-runner.js";
import type { BranchLaunch } from "./branch-view.js";
import type { LiveLaunch } from "./launch-registry.js";
import { markAnswer, type MarkedAnswer } from "./quorum-branch.js";
import type { BranchTicket } from "./records.js";

/**
 * A branch's answer (#279, #340): the entries its node opened — an undoable action's, the ones a child
 * workflow's finish moved up (#1281b) — made before its arbiters judge it, so an arbiter that throws,
 * or a budget that stops its model call, fails the branch with them (#1281): the join undoes them.
 */

/** What a branch that answered needs of its run. */
export interface AnsweringRun {
  readonly node: RuntimeNode;
  readonly ticket: BranchTicket;
  readonly owner: BranchLaunch;
  readonly live: LiveLaunch;
  readonly deps: BranchDeps;
  /** Where its entries go when it fails: its failed update's. */
  readonly compensations: CompensationEntry[];
  /** Where its node's spend goes when it fails. */
  readonly answered: UsageRecord[];
}

/** The entries a branch that answered opens (#340), with the ones its child's finish moved up (#1281b). */
export async function answeredEntriesOf(
  run: AnsweringRun,
  site: {
    readonly view: ExecutionStateType;
    readonly frame: FrameSpec;
    readonly config: RunnableConfig | undefined;
  },
  outcome: NodeOutcome,
): Promise<ExecutionStateUpdate> {
  const { node, ticket, deps } = run;
  const { view, frame, config } = site;
  const branch = {
    launchId: run.owner.ticket.launchId,
    branchIndex: ticket.index,
    value: outcome.value,
  };
  const opened = await compensationsOfBranch({ node, view, frame, config, branch, deps });
  const taken = { taken: outcome.compensations, branch, parts: deps.compensation, frame };
  return withTaken(taken, opened);
}

/**
 * The quorum's mark of a branch's answer (#279). Its entries are open by then: an arbiter that
 * throws — or a budget that stops it — fails the branch with them and its node's spend, so its
 * join undoes what the branch did (`CompensationReason.JoinFailed`) and counts what it spent.
 */
export async function markedAnswer(
  run: AnsweringRun,
  answered: { readonly outcome: NodeOutcome; readonly entries: ExecutionStateUpdate },
  arbiters: Parameters<typeof markAnswer>[3],
): Promise<MarkedAnswer | undefined> {
  try {
    return await markAnswer(run.live, run.ticket, answered.outcome.value, arbiters);
  } catch (error) {
    const { compensations } = answered.entries;
    if (Array.isArray(compensations)) run.compensations.push(...compensations);
    run.answered.push(...(answered.outcome.usage ?? []));
    throw error;
  }
}
