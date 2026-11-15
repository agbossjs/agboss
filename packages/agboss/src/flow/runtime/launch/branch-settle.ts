import type { RunnableConfig } from "@langchain/core/runnables";
import { launchPausesOf, withdrawLaunchPauses } from "./withdrawn-pauses.js";
import { expiredErrorOf } from "./expired-branch.js";
import type { LiveLaunch } from "./launch-registry.js";
import { BranchStatus, type BranchTicket } from "./records.js";
import type { BranchLaunch } from "./branch-view.js";
import type { BranchQuorumDeps } from "./branch-quorum.js";
import type { ErrorRecord } from "../../../core/error-record.js";
import type { ExecutionStateType } from "../state.js";

/** What ending a branch needs of its run: where it runs and which launch it belongs to. */
export interface SettleRun {
  readonly state: ExecutionStateType;
  readonly config: RunnableConfig | undefined;
  readonly ticket: BranchTicket;
  readonly owner: BranchLaunch;
  readonly live: LiveLaunch;
  readonly deps: BranchQuorumDeps;
}

/** How a branch ended, as far as settling its pauses changes it. */
export interface SettledEnd {
  readonly status: BranchStatus;
  readonly error?: ErrorRecord;
}

/**
 * Withdraws the pending pauses under `branches` of the run's launch (#267 AC10, #337): its own when
 * it ended `Cancelled` (asked after the abort), its siblings' when it failed.
 */
export const withdrawUnder = (run: SettleRun, branches: readonly BranchTicket[]): Promise<void> =>
  withdrawLaunchPauses(launchPausesOf(run.deps.pauses, run.state, run.config), branches);

/** A failed branch aborts its launch: its siblings stop, their pending pauses are withdrawn. */
export async function abortLaunch(run: SettleRun): Promise<void> {
  const { live, owner, ticket } = run;
  live.controller.abort();
  await withdrawUnder(
    run,
    owner.ticket.branches.filter((branch) => branch.index !== ticket.index),
  );
}

/**
 * A branch that ended `Cancelled` takes back its pause; one that never ran again because its
 * launch was aborted by a quorum deadline may have had its pause expire (#945): it is `Expired`,
 * with the expiry's error, once the pause is closed — a close at or after the deadline is recorded
 * `Expired` by the store.
 */
export async function settledEnd<TEnd extends SettledEnd>(
  run: SettleRun,
  end: TEnd,
): Promise<TEnd> {
  if (end.status !== BranchStatus.Cancelled) return end;
  await withdrawUnder(run, [run.ticket]);
  const site = launchPausesOf(run.deps.pauses, run.state, run.config);
  const error =
    site === undefined
      ? undefined
      : await expiredErrorOf(site, run.ticket, run.state.contexts.deadline?.at);
  return error === undefined ? end : { ...end, status: BranchStatus.Expired, error };
}
