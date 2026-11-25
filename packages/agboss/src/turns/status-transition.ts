/**
 * The status history of a thread (#1341d): every change of a thread's status is one row of
 * `thread_status_transitions`, written in the very transaction of the change — a lease mark
 * (`requestStop`, `requestCancel`, a pause) or a record's status write (`append`, `complete`,
 * `completeIfStatus`) — so a crash between the change and its row is impossible by construction.
 * `app.getStatusHistory(threadId)` reads it, oldest first.
 */

/** Where a thread is, as the history names it (what a lease's marks and its record's status make together). */
export enum ThreadStatus {
  /** A tree of the thread moves. */
  Running = "running",
  /** It waits for a decision (`@ExternalTask`, `@ToolApproval`: a business pause). */
  Paused = "paused",
  /** An operator's `app.pause` was requested and the in-flight step still finishes (`InterruptMode.AfterStep`). */
  Pausing = "pausing",
  /** Frozen by an operator's `app.pause`, with no business pause open. */
  ExternallyPaused = "externally-paused",
  /** Frozen by an operator while a business pause is open too: both must be lifted. */
  DualPaused = "dual-paused",
  /** An operator's `app.stop` was requested and the lease holder still winds down. */
  Stopping = "stopping",
  /** Halted where it stood (`ExecutionStatus.Stopped`): terminal. */
  Stopped = "stopped",
  /** An operator's `app.cancel` was requested and its undo is under way. */
  Cancelling = "cancelling",
  /** Aborted and undone (`ExecutionStatus.Cancelled`): terminal. */
  Cancelled = "cancelled",
  /** Reached a workflow finish: terminal. */
  Finished = "finished",
  /** Failed: terminal. */
  Failed = "failed",
}

/** What made the thread change its status. */
export enum StatusTrigger {
  /** A new execution began. */
  Start = "start",
  /** The graph asked for a decision (`@ExternalTask`, `@ToolApproval`). */
  Ask = "ask",
  /** An answered pause, an expiry or a recovery moved the tree on. */
  Resume = "resume",
  /** `app.pause`. */
  Pause = "pause",
  /** `app.unpause`. */
  Unpause = "unpause",
  /** `app.stop`. */
  Stop = "stop",
  /** `app.cancel`. */
  Cancel = "cancel",
  /** The workflow reached a finish. */
  Finish = "finish",
  /** The execution failed. */
  Fail = "fail",
}

/** One change of a thread's status (#1341d), as `app.getStatusHistory(threadId)` returns it. */
export interface ThreadStatusTransition {
  readonly tenantId: string;
  readonly threadId: string;
  /** 1 for the thread's first change, + 1 for each later one: the order of the history. */
  readonly seq: number;
  /** The status before; `null` for the thread's first change. */
  readonly fromStatus: ThreadStatus | null;
  readonly toStatus: ThreadStatus;
  readonly trigger: StatusTrigger;
  /** The operator's reason, when the change was a command that gave one. */
  readonly reason?: string | undefined;
  /** Who gave the command (`ownerId`), when one did. */
  readonly actor?: string | undefined;
  /** The fence of the lease that held the tree when the change was written, when one did. */
  readonly leaseToken?: number | undefined;
  readonly at: Date;
}

/**
 * A change to write: what `from`, `seq` and `at` are is the store's to say — the thread's last
 * row, one more than its seq, the store's clock — inside the transaction that writes it.
 */
export interface NewStatusTransition {
  readonly tenantId: string;
  readonly threadId: string;
  readonly toStatus: ThreadStatus;
  readonly trigger: StatusTrigger;
  readonly reason?: string | undefined;
  readonly actor?: string | undefined;
  readonly leaseToken?: number | undefined;
}

/** What a record write may say about the change it makes: the default is read from its statuses. */
export type StatusContext = Partial<
  Pick<NewStatusTransition, "toStatus" | "trigger" | "reason" | "actor" | "leaseToken">
>;

const ENDING: readonly (ThreadStatus | undefined)[] = [
  ThreadStatus.Stopping,
  ThreadStatus.Cancelling,
];

/**
 * The row a status change writes, or `undefined` when it changes nothing: a repeated command, or
 * a write that leaves the thread's status as it was, is not a transition.
 */
export function transitionOf(
  next: NewStatusTransition,
  last: ThreadStatusTransition | undefined,
  at: Date,
): ThreadStatusTransition | undefined {
  if (last?.toStatus === next.toStatus) return undefined;
  // a stop or cancel under way moves its record through `running` while it ends (its recovery
  // marker): the thread is still stopping or cancelling, never running again
  if (next.toStatus === ThreadStatus.Running && ENDING.includes(last?.toStatus)) return undefined;
  const { reason, actor, leaseToken, ...base } = next;
  return {
    ...base,
    seq: (last?.seq ?? 0) + 1,
    fromStatus: last?.toStatus ?? null,
    ...detailsOf({ reason, actor, leaseToken }),
    at,
  };
}

/** What made the status when no command says so: a write of `running` after a pause is a resume. */
function ownTriggerOf(
  made: { readonly status: ThreadStatus; readonly trigger: StatusTrigger },
  last: ThreadStatusTransition | undefined,
): StatusTrigger {
  const wasPaused =
    last?.toStatus === ThreadStatus.Paused || last?.toStatus === ThreadStatus.DualPaused;
  return made.status === ThreadStatus.Running && wasPaused ? StatusTrigger.Resume : made.trigger;
}

/**
 * The transition a record's status write makes, from the statuses alone (a command's context
 * overrides the trigger): `undefined` for a status that is no thread status (`queued`, `written`).
 */
export function recordTransitionOf(
  thread: { readonly tenantId: string; readonly threadId: string },
  turnStatus: string,
  last: ThreadStatusTransition | undefined,
  context: StatusContext | undefined,
): NewStatusTransition | undefined {
  const made = RECORD_STATUS[turnStatus];
  if (made === undefined) return undefined;
  return {
    ...thread,
    // a command may name the status its write makes (an operator's pause: `ExternallyPaused`)
    toStatus: context?.toStatus ?? made.status,
    trigger: context?.trigger ?? ownTriggerOf(made, last),
    ...detailsOf(context),
  };
}

/** The reason, actor and lease token of a command's context, those it gave. */
const detailsOf = (context: StatusContext | undefined) => ({
  ...(context?.reason === undefined ? {} : { reason: context.reason }),
  ...(context?.actor === undefined ? {} : { actor: context.actor }),
  ...(context?.leaseToken === undefined ? {} : { leaseToken: context.leaseToken }),
});

/** The thread status each record status makes, and what made it when no command says so (`queued` and `written` make none). */
const RECORD_STATUS: Readonly<
  Record<string, { readonly status: ThreadStatus; readonly trigger: StatusTrigger } | undefined>
> = {
  running: { status: ThreadStatus.Running, trigger: StatusTrigger.Start },
  paused: { status: ThreadStatus.Paused, trigger: StatusTrigger.Ask },
  answered: { status: ThreadStatus.Finished, trigger: StatusTrigger.Finish },
  guarded: { status: ThreadStatus.Finished, trigger: StatusTrigger.Finish },
  failed: { status: ThreadStatus.Failed, trigger: StatusTrigger.Fail },
  stopped: { status: ThreadStatus.Stopped, trigger: StatusTrigger.Stop },
  cancelled: { status: ThreadStatus.Cancelled, trigger: StatusTrigger.Cancel },
};
