import { AGBossError } from "../core/errors.js";
import type { PauseKind } from "../pause/types.js";
import type { Milliseconds } from "../units/index.js";
import type { Expiry } from "./expiry.js";

/**
 * Infrastructure (#807, A2A v1.0 design §4.1.6): the A2A tasks an application serves. One row per
 * task — keyed `(tenantId, taskId)`, the task id its root execution's reserved id — and one row per
 * accepted message, initial or follow-up, unique on `(tenantId, ownerId, messageId)`: a message
 * resent with the same id finds the task it was accepted for, never a second one. A task's status
 * moves by compare-and-set on its `version` (one more per change), and a terminal status never
 * changes again (sticky): a stale writer's late `WORKING` cannot overwrite `COMPLETED`. Finished
 * tasks are removed by the recovery sweep after `@Application({ a2a: { taskRetention } })`
 * (default `hours(24)`); unfinished ones never are. Listed only in `@Application({ providers })`;
 * the built-in default is in memory, `SqliteA2ATaskRepository` shares the tasks between instances
 * on one file. A store of your own proves itself with `a2aTaskContract`
 * (`@agboss/core/testing/contracts`).
 */

/** A task's state, as A2A v1.0 names it on the wire (ProtoJSON, §5.5). */
export enum A2ATaskState {
  Submitted = "TASK_STATE_SUBMITTED",
  Working = "TASK_STATE_WORKING",
  InputRequired = "TASK_STATE_INPUT_REQUIRED",
  Completed = "TASK_STATE_COMPLETED",
  Failed = "TASK_STATE_FAILED",
  Canceled = "TASK_STATE_CANCELED",
  Rejected = "TASK_STATE_REJECTED",
}

/** The states a task never leaves (§4.1.3): it is over. */
export type A2ATerminalTaskState =
  A2ATaskState.Completed | A2ATaskState.Failed | A2ATaskState.Canceled | A2ATaskState.Rejected;

const TERMINAL: ReadonlySet<A2ATaskState> = new Set<A2ATaskState>([
  A2ATaskState.Completed,
  A2ATaskState.Failed,
  A2ATaskState.Canceled,
  A2ATaskState.Rejected,
]);

/** Whether a task in `state` is over: its status never changes again. */
export const isTerminalA2ATaskState = (state: A2ATaskState): state is A2ATerminalTaskState =>
  TERMINAL.has(state);

/** A task's key: its tenant and its id. */
export interface A2ATaskKey {
  readonly tenantId: string;
  readonly taskId: string;
}

/** An accepted message's key: its tenant, its caller and the id its author gave it (§4.1.4). */
export interface A2AMessageKey {
  readonly tenantId: string;
  /** The resolved caller (`undefined`: none); another owner's message id is another message. */
  readonly ownerId: string | undefined;
  readonly messageId: string;
}

/** A pause the task waits for, as a caller may answer it (`INPUT_REQUIRED`). */
export interface A2ATaskPause {
  /** What a follow-up message names; absent for a pause only its channel may answer. */
  readonly pauseId?: string;
  readonly kind: PauseKind;
  /** The question, masked as the execution's pending pauses are. */
  readonly ask: unknown;
}

/** Where a task is: what a status change writes, all of it at once. */
export interface A2ATaskStatus {
  readonly state: A2ATaskState;
  /** The agent's status message (a channel-only pause's "awaiting …", a failure's text). */
  readonly message?: string;
  /** The pauses it waits for; `[]` unless it waits. */
  readonly pendingPauses: readonly A2ATaskPause[];
  /** The finish it reached (`COMPLETED`). */
  readonly finish?: string;
  /** The finish's output (`COMPLETED`), plain JSON. */
  readonly output?: unknown;
  /** Why it failed or was rejected: a stable code (`limit.hops`, `a2a.start-lost`, …). */
  readonly errorCode?: string;
  /**
   * When read repair asked a start it could not fence out to stop (ISO 8601): the task settles
   * `a2a.start-lost` one start timeout later, unless its execution began meanwhile. Never on the wire.
   */
  readonly cancelRequestedAt?: string;
}

/** A task as kept. */
export interface A2ATaskRecord extends A2ATaskKey {
  readonly ownerId: string | undefined;
  /** Its A2A `contextId`: its execution's thread. */
  readonly contextId: string;
  /** The skill (the exported start's name) it runs. */
  readonly skill: string;
  readonly status: A2ATaskStatus;
  /** 1 when saved, one more per status change. */
  readonly version: number;
  /** When it was accepted, on the application's clock. */
  readonly acceptedAt: Date;
  /** When its status last changed (`acceptedAt` until then): what `list` sorts by. */
  readonly statusAt: Date;
  /** The authenticated mesh peer that sent it, if any. */
  readonly callerPeer?: string;
}

/** An accepted message as kept: the task it was accepted for, and its reply once it has one. */
export interface A2AMessageRecord extends A2AMessageKey {
  /** The hash of what the message asked: a resend with another one is not the same message. */
  readonly requestHash: string;
  readonly taskId: string;
  readonly savedAt: Date;
  /** What a follow-up was answered (plain JSON): a resend replays it. */
  readonly reply?: unknown;
}

/** A task to accept with its first message. */
export interface NewA2ATask extends Omit<A2ATaskRecord, "version" | "statusAt"> {
  readonly messageId: string;
  readonly requestHash: string;
}

/** What `saveIfAbsent` did. */
export enum A2ATaskSaveStatus {
  /** The task and its message are saved: this call accepted it. */
  Saved = "saved",
  /** The message was accepted before: the task it was accepted for (gone once swept). */
  MessageTaken = "message-taken",
  /** Another message's task has the id: nothing is saved. */
  TaskIdTaken = "task-id-taken",
}

export type A2ATaskSave =
  | { readonly status: A2ATaskSaveStatus.Saved; readonly task: A2ATaskRecord }
  | {
      readonly status: A2ATaskSaveStatus.MessageTaken;
      readonly message: A2AMessageRecord;
      readonly task: A2ATaskRecord | undefined;
    }
  | { readonly status: A2ATaskSaveStatus.TaskIdTaken };

/** Which tasks `list` reads: a caller's, newest status first. */
export interface A2ATaskQuery {
  readonly tenantId: string;
  readonly ownerId: string | undefined;
  readonly contextId?: string;
  readonly state?: A2ATaskState;
  /** At most this many (a whole number from 1). */
  readonly pageSize: number;
  /** The previous page's `nextPageToken`; absent or `""` for the first page. */
  readonly pageToken?: string;
}

/** A page of tasks, and where the next one starts (`""` on the last page, §3.1.4). */
export interface A2ATaskPage {
  readonly tasks: readonly A2ATaskRecord[];
  readonly nextPageToken: string;
}

/** A page token that no `list` of this store gave. */
export class InvalidA2APageTokenError extends AGBossError {
  static override readonly code: string = "a2a.invalid-page-token";

  constructor() {
    super("the page token is not one a list of these tasks gave");
  }
}

export abstract class A2ATaskRepository {
  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * Accepts a task with its first message, atomically: both saved, or — the message accepted
   * before — nothing saved and the task it was accepted for, or — the task id taken — nothing.
   */
  abstract saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave>;

  /** Accepts a follow-up message; `undefined` when this call saved it, else the one kept. */
  abstract saveMessageIfAbsent(message: A2AMessageRecord): Promise<A2AMessageRecord | undefined>;

  /** Keeps a message's reply once; `true` when this call kept it (none kept before). */
  abstract saveReplyIfAbsent(key: A2AMessageKey, reply: unknown): Promise<boolean>;

  abstract findById(key: A2ATaskKey): Promise<A2ATaskRecord | undefined>;

  abstract findByMessage(key: A2AMessageKey): Promise<A2AMessageRecord | undefined>;

  /**
   * Writes `status` at `statusAt` only while the task is at `expectedVersion` and not terminal,
   * atomically: the task as written (`version + 1`), else `undefined` — nothing written.
   */
  abstract compareAndSetStatus(
    key: A2ATaskKey,
    expectedVersion: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined>;

  /** A caller's tasks by `statusAt`, newest first (ties by task id, descending). */
  abstract list(query: A2ATaskQuery): Promise<A2ATaskPage>;

  /** Removes the terminal tasks whose status changed before `cutoff`, with their messages. */
  abstract deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void>;
}

/** A task as `saveIfAbsent` keeps it: version 1, its status as of its acceptance. */
export const savedA2ATaskOf = (task: NewA2ATask): A2ATaskRecord => ({
  tenantId: task.tenantId,
  taskId: task.taskId,
  ownerId: task.ownerId,
  contextId: task.contextId,
  skill: task.skill,
  status: task.status,
  version: 1,
  acceptedAt: task.acceptedAt,
  statusAt: task.acceptedAt,
  ...(task.callerPeer === undefined ? {} : { callerPeer: task.callerPeer }),
});

/** The first message of a new task. */
export const firstA2AMessageOf = (task: NewA2ATask): A2AMessageRecord => ({
  tenantId: task.tenantId,
  ownerId: task.ownerId,
  messageId: task.messageId,
  requestHash: task.requestHash,
  taskId: task.taskId,
  savedAt: task.acceptedAt,
});

/** The recovery sweep's removal of finished tasks (#807), after `retention` on the `Clock`. */
export const a2aTaskExpiryOf = (tasks: A2ATaskRepository, retention: Milliseconds): Expiry => ({
  what: "the finished A2A tasks",
  remove: (cutoff: Date) => tasks.deleteTerminalByStatusAtBefore(cutoff),
  retention,
});
