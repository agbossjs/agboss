import type { RunnableConfig } from "@langchain/core/runnables";
import { extractRunContext } from "../../../core/run-context.js";
import {
  cancelledPause,
  logPauseAnswer,
  PauseResolution,
  PauseStatus,
  type PauseCancellation,
  type PauseRecord,
} from "../../../infrastructure/pause-record.js";
import type { PauseSeam, WithdrawalTree } from "../../../pause/index.js";
import { rootFactsOf } from "../../context/frame.js";
import { branchKeyOf, PauseWithdrawnError } from "../pause.js";
import type { ExecutionStateType } from "../state.js";
import type { BranchTicket } from "./records.js";

/**
 * Pauses closed without an answer (#267 AC10, #337). A `FailFast` failure cancels its launch,
 * paused siblings too; a decided quorum cancels the branches it no longer needs; a branch that ends
 * `Cancelled` takes back what it asked after the abort. Their pending pauses are withdrawn
 * (`Cancelled`, `PauseResolution.Withdrawn`), so the tree goes on to the join instead of waiting
 * for answers nobody needs, and a late answer gets `NotPausedError`; a withdrawn branch ends
 * `Cancelled` when it runs again. A pause belongs to a branch when it waits in the branch's step or
 * in any execution under it (a child workflow, #263): its record keeps the keys of the launching
 * steps above it (`branchKeys`). Whoever closes a sent pause tells its channel (`withdraw`).
 */

/** The pause records, the log of how each was resolved, and who tells the channels. */
export type PauseStores = Pick<PauseSeam, "pauses" | "answers" | "withdrawn">;

/** A pause's branch keys; one stored before #337 has its own step's only. */
const branchKeysOf = (pause: PauseRecord): readonly string[] =>
  pause.branchKeys ?? [branchKeyOf(pause)];

/**
 * Closes one pending pause without an answer: logged, and its channel told when it was sent — the
 * record read after the change, so a `send` that returned meanwhile is seen (else its own step
 * tells it). `false` when it was no longer pending.
 */
export async function withdrawPause(
  stores: PauseStores,
  pause: PauseRecord,
  closing: {
    readonly resolution: PauseCancellation;
    readonly at: Date;
    readonly tree?: WithdrawalTree;
  },
): Promise<boolean> {
  const { tenantId, pauseId } = pause;
  const { resolution, at, tree } = closing;
  if (!(await stores.pauses.cancelByTenantIdAndPauseId(tenantId, pauseId, resolution, at)))
    return false;
  await logPauseAnswer(stores.answers, cancelledPause(pause, resolution, at), resolution);
  const closed = await stores.pauses.findByTenantIdAndPauseId(tenantId, pauseId);
  if (closed?.isSent === true && stores.withdrawn !== undefined)
    await stores.withdrawn({ pause: closed, resolution, ...(tree === undefined ? {} : { tree }) });
  return true;
}

/** Where a launch's pauses are withdrawn: its tree, the execution that launched, the clock. */
export interface LaunchPauses {
  readonly stores: PauseStores;
  readonly tenantId: string;
  readonly rootExecutionId: string;
  /** The execution whose step launched the branches. */
  readonly launchExecutionId: string;
  readonly tree: WithdrawalTree;
  /** When (the application's clock): the pauses' `resolvedAt`. */
  readonly now: () => Date;
}

/** A launch's pauses in the execution that runs it; `undefined` without the application's stores. */
export function launchPausesOf(
  stores: PauseStores | undefined,
  state: ExecutionStateType,
  config: RunnableConfig | undefined,
): LaunchPauses | undefined {
  if (stores === undefined) return undefined;
  const { run, clock } = extractRunContext(config, state.runId);
  // inside a child (#263) the records belong to the tree's root
  const root =
    run.tree === undefined ? state.runId : rootFactsOf(run.tree.parent.execution).executionId;
  return {
    stores,
    tenantId: state.contexts.tenant.tenantId,
    rootExecutionId: root,
    launchExecutionId: state.runId,
    tree: { contexts: state.contexts, ownerId: run.ownerId, startedVersion: state.startedVersion },
    now: () => clock.now(),
  };
}

/** Withdraws every pending pause that waits under one of `branches` of the launch. */
export async function withdrawBranchPauses(
  site: LaunchPauses,
  branches: readonly BranchTicket[],
): Promise<void> {
  if (branches.length === 0) return;
  const keys = new Set(
    branches.map((branch) => branchKeyOf({ ...branch, executionId: site.launchExecutionId })),
  );
  const { stores, tenantId, rootExecutionId, tree } = site;
  const records = await stores.pauses.findAllByTenantIdAndRootExecutionId(
    tenantId,
    rootExecutionId,
  );
  const waiting = records.filter(
    (pause) =>
      pause.status === PauseStatus.Pending && branchKeysOf(pause).some((key) => keys.has(key)),
  );
  const at = site.now();
  for (const pause of waiting)
    await withdrawPause(stores, pause, { resolution: PauseResolution.Withdrawn, at, tree });
}

/** Whether a branch stopped because its pause was withdrawn (also through a cause). */
export function isWithdrawn(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof PauseWithdrawnError) return true;
  }
  return false;
}

/**
 * The withdrawal of a decided quorum (#337): started once, when the quorum is decided — by an
 * answer, its deadline, or on restore — and awaited by every branch of the pass as it ends, so the
 * pass ends with the pauses closed and the drain takes them before the tree rests. A deadline that
 * passes while no branch of the pass runs (the tree rests) withdraws nothing: the next pass finds
 * the quorum decided and withdraws then (S1 Q3).
 */
export class DecisionWithdrawal {
  #done: Promise<void> | undefined;
  #running = 0;

  constructor(private readonly withdraw: () => Promise<void>) {}

  /** Starts the withdrawal (once). */
  start(): void {
    if (this.#done !== undefined) return;
    const done = this.withdraw();
    // a branch end awaits it; a store failure fails that branch's node there, never unhandled
    done.catch(() => undefined);
    this.#done = done;
  }

  /** Starts it only while a branch of this pass runs: its end awaits it. */
  startWhileRunning(): void {
    if (this.#running > 0) this.start();
  }

  /** A branch's run: counted while it runs, and it ends only once the withdrawal started is done. */
  async during<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    this.#running += 1;
    try {
      return await work();
    } finally {
      await (this.#done ?? Promise.resolve());
      this.#running -= 1;
    }
  }
}
