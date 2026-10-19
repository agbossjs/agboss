import { isGraphInterrupt } from "@langchain/langgraph";
import type { Class } from "../../../components/injection.js";

/**
 * How the branches of a launch are scheduled (#262 S33, internal): in production the launch's
 * semaphore alone (`maxConcurrency`, no scheduler); in a test its `TestConcurrency` — one branch at
 * a time (`Sequential`), or completion gates (`inOrder`): each branch runs to its completion point
 * (its node answered or threw) and waits there until the test's order lets it go on. A pause passes
 * at once; a branch waiting at its gate listens to its signal — a `FailFast`, a decided quorum or a
 * cancel ends it at once.
 */

/** One branch as its scheduler sees it. */
export interface ScheduledBranch {
  /** Its launch's id and its place in it (the ticket's index: listed or item order). */
  readonly launchId: string;
  readonly index: number;
  /** Its id in `result.path`: `critic-agent#2` for a copy. */
  readonly nodeId: string;
  /** The component it runs. */
  readonly component: Class;
  /** What its node reads (read when asked), for a scheduler that matches steps by input. */
  readonly input: () => Readonly<Record<string, unknown>>;
}

export interface BranchScheduler {
  /** The launch's slots: given what it declares (`maxConcurrency`, else every branch). */
  slotsOf(declared: number): number;
  /** The branch's task began: it waits for a slot until `started`. */
  entered(branch: ScheduledBranch): void;
  /** The branch took a slot and runs. */
  started(branch: ScheduledBranch): void;
  /**
   * The branch's node completed: resolves when it may go on; rejects when `signal` aborts first
   * (it ends cancelled) or when the order can no longer be kept (the test fails).
   */
  completed(branch: ScheduledBranch, signal: AbortSignal): Promise<void>;
  /** The branch ended: its slot is free. */
  ended(branch: ScheduledBranch): void;
}

/** What a gated node gave: its result, or what it threw. */
type Completion<TResult> =
  | { readonly isDone: true; readonly result: TResult }
  | { readonly isDone: false; readonly error: unknown };

/** Where a branch is gated: its scheduler (none in production), the branch, its signal. */
export interface GateSite {
  readonly scheduler: BranchScheduler | undefined;
  readonly branch: ScheduledBranch;
  readonly signal: AbortSignal;
}

/** Runs a branch's node, then waits at its completion gate — answered or failed alike. */
export async function gated<TResult>(
  site: GateSite,
  work: () => Promise<TResult>,
): Promise<TResult> {
  if (site.scheduler === undefined) return work();
  let completion: Completion<TResult>;
  try {
    completion = { isDone: true, result: await work() };
  } catch (error) {
    if (isGraphInterrupt(error)) throw error;
    completion = { isDone: false, error };
  }
  await site.scheduler.completed(site.branch, site.signal);
  if (!completion.isDone) throw completion.error;
  return completion.result;
}

/** Runs a branch's task between its scheduler's `entered` and `ended` (none in production). */
export async function inSchedule<TResult>(
  scheduler: BranchScheduler | undefined,
  branch: ScheduledBranch,
  work: () => Promise<TResult>,
): Promise<TResult> {
  scheduler?.entered(branch);
  try {
    return await work();
  } finally {
    scheduler?.ended(branch);
  }
}
