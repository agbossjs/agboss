import type { Message } from "@a2a-js/sdk";
import { AGBossError } from "../../core/errors.js";

/** A task id or context id a remote gave, as the client keeps it: a key's text of a safe charset. */
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;

/** `id` when it is one the client may keep and show, else `undefined` (never a free text). */
export const safeTaskIdOf = (id: unknown): string | undefined =>
  typeof id === "string" && SAFE_ID.test(id) ? id : undefined;

/**
 * How a remote task ended without an output, as the call fails with it (#809, design §4.2
 * "Outcomes"): its ids (checked when they came, `safeTaskIdOf`), how it ended, an AGBoss peer's
 * stable code — never the task's status text.
 */

/** How an A2A task ended without an output (the spec's state names). */
export enum A2ATaskEnd {
  Failed = "failed",
  Rejected = "rejected",
}

/** What a failed task knows: its ids, how it ended and an AGBoss peer's error code. */
export interface A2ATaskFailedErrorOptions {
  readonly agent: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly end: A2ATaskEnd;
  /** The peer's stable error code (an AGBoss peer's, read from the mesh extension); none: `undefined`. */
  readonly remoteCode: string | undefined;
}

/**
 * The remote task ended FAILED or REJECTED (#809): its ids, how it ended and — from an AGBoss peer —
 * its stable error code (`remoteCode`); never the task's status text. A mesh limit of an AGBoss peer
 * is not this error: it is rebuilt as the same `LimitExceededError`.
 */
export class A2ATaskFailedError extends AGBossError {
  static override readonly code = "a2a.task-failed" as const;
  override name = "A2ATaskFailedError";
  readonly agent: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly end: A2ATaskEnd;
  readonly remoteCode: string | undefined;

  constructor(options: A2ATaskFailedErrorOptions) {
    const code = options.remoteCode === undefined ? "" : ` (${options.remoteCode})`;
    super(`the task ${options.taskId} of A2A agent ${options.agent} ended ${options.end}${code}`, {
      details: {
        agent: options.agent,
        taskId: options.taskId,
        end: options.end,
        ...(options.remoteCode === undefined ? {} : { remoteCode: options.remoteCode }),
      },
    });
    this.agent = options.agent;
    this.taskId = options.taskId;
    this.contextId = options.contextId;
    this.end = options.end;
    this.remoteCode = options.remoteCode;
  }
}

/** A task's ids and its agent. */
export interface A2ATaskErrorOptions {
  readonly agent: string;
  readonly taskId: string;
  readonly contextId: string;
}

/** The remote task ended CANCELED (#809): by its agent, by `cancel(taskId)` or a deadline's cancel. */
export class A2ATaskCanceledError extends AGBossError {
  static override readonly code = "a2a.task-canceled" as const;
  override name = "A2ATaskCanceledError";
  readonly agent: string;
  readonly taskId: string;
  readonly contextId: string;

  constructor(options: A2ATaskErrorOptions) {
    super(`the task ${options.taskId} of A2A agent ${options.agent} was canceled`, {
      details: { agent: options.agent, taskId: options.taskId },
    });
    this.agent = options.agent;
    this.taskId = options.taskId;
    this.contextId = options.contextId;
  }
}

/** Why a task waits for its caller. */
export enum A2ATaskInterruption {
  InputRequired = "input-required",
  AuthRequired = "auth-required",
}

/** What an interrupted task knows. */
export interface A2ATaskInterruptedErrorOptions extends A2ATaskErrorOptions {
  readonly interruption: A2ATaskInterruption;
}

/**
 * The remote task waits for its caller (#809): INPUT_REQUIRED or AUTH_REQUIRED. `execute` throws it
 * — a remote pause is not a local one in 0.1.1 — and `send` / `reply` return the task instead;
 * `reply(taskId, …)` continues it.
 */
export class A2ATaskInterruptedError extends AGBossError {
  static override readonly code = "a2a.task-interrupted" as const;
  override name = "A2ATaskInterruptedError";
  readonly agent: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly interruption: A2ATaskInterruption;

  constructor(options: A2ATaskInterruptedErrorOptions) {
    super(
      `the task ${options.taskId} of A2A agent ${options.agent} waits for its caller (${options.interruption}): reply(taskId, …) continues it`,
      {
        details: {
          agent: options.agent,
          taskId: options.taskId,
          interruption: options.interruption,
        },
      },
    );
    this.agent = options.agent;
    this.taskId = options.taskId;
    this.contextId = options.contextId;
    this.interruption = options.interruption;
  }
}

/** How the best-effort cancel at a deadline went. */
export enum A2ACancelOutcome {
  /** The agent answered the task CANCELED. */
  Canceled = "canceled",
  /** The agent answered, the task in another state (it may still end on its side). */
  NotCanceled = "not-canceled",
  /** The agent refused it (an error answer: the task not cancelable, the caller refused, …). */
  Refused = "refused",
  /** No answer within the cancel's own bound. */
  NoAnswer = "no-answer",
}

/** What a call that ran out of time knows. */
export interface A2ACallDeadlineErrorOptions extends A2ATaskErrorOptions {
  /** When the wait ended (ISO 8601). */
  readonly deadlineAt: string;
  readonly cancel: A2ACancelOutcome;
}

/**
 * The wait for a remote task reached its deadline (#809): the execution's deadline, or the call's
 * own. The client sent a best-effort CancelTask (`isCanceled`: the agent answered CANCELED); the
 * task may still end later on the agent's side.
 */
export class A2ACallDeadlineError extends AGBossError {
  static override readonly code = "a2a.deadline" as const;
  override name = "A2ACallDeadlineError";
  readonly agent: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly deadlineAt: string;
  readonly cancel: A2ACancelOutcome;
  /** Whether the agent answered the cancel with a CANCELED task. */
  readonly isCanceled: boolean;

  constructor(options: A2ACallDeadlineErrorOptions) {
    const canceled = `the cancel asked: ${options.cancel}`;
    super(
      `the task ${options.taskId} of A2A agent ${options.agent} did not end by ${options.deadlineAt}: ${canceled}`,
      { details: { agent: options.agent, taskId: options.taskId, deadlineAt: options.deadlineAt } },
    );
    this.agent = options.agent;
    this.taskId = options.taskId;
    this.contextId = options.contextId;
    this.deadlineAt = options.deadlineAt;
    this.cancel = options.cancel;
    this.isCanceled = options.cancel === A2ACancelOutcome.Canceled;
  }
}

/** Whether a message's ids are safe ids (#860): its `messageId`, its `contextId` when it has one. */
export const hasSafeIds = (message: Pick<Message, "messageId" | "contextId">): boolean =>
  safeTaskIdOf(message.messageId) !== undefined &&
  (message.contextId === "" || safeTaskIdOf(message.contextId) !== undefined);
