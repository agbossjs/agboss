import type { CancelFencedKey, ExecutionCancelFencedErrorOptions } from "./cancel-fenced.js";
import { ExecutionCancelledError, type ExecutionCancelledErrorOptions } from "../core/errors.js";
/**
 * The run was stopped (#1341b): `app.stop` halted it where it stood — what it had done is kept, nothing
 * is undone. It is the abort reason of a stopped execution and of the steps it interrupts (a cancel
 * subclass, so every place that stops on a cancel stops on it too); `app.execute` and `app.resume`
 * resolve with `ExecutionStatus.Stopped`, they never reject with it.
 */
export class ExecutionStoppedError extends ExecutionCancelledError {
  static override readonly code: string = "execution.stopped";
  override name = "ExecutionStoppedError";

  constructor(options: ExecutionCancelledErrorOptions = {}) {
    super({ message: "the execution was stopped", ...options });
  }
}

/**
 * The run was frozen from outside (#1341c): `app.pause` parks it at its next step boundary (or at once,
 * `Immediate`). It is the abort reason of a pause in flight and rides every path a stop does — nothing
 * is undone, the lease stays held — but it ends in no record: the pass that met it parks the tree (its
 * record `paused`, its checkpoint kept) and its call resolves `ExecutionStatus.Paused` with
 * `isExternallyPaused`. `app.execute` and `app.resume` never reject with it.
 */
export class ExecutionPausedError extends ExecutionStoppedError {
  static override readonly code: string = "execution.paused";
  override name = "ExecutionPausedError";

  constructor(options: ExecutionCancelledErrorOptions = {}) {
    super({ message: "the execution was paused", ...options });
  }
}

/** Whether `error` is a pause (or caused by one): the end that parks the tree instead of ending it. */
export function isPause(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause)
    if (current instanceof ExecutionPausedError) return true;
  return false;
}

/**
 * A fenced write or an outbound call was refused because its tree's `Immediate` pause fenced the
 * lease it ran under (#1341c): nothing was written or sent. It is no hand-over — the write raced the
 * pause that is parking its holder: the holder takes it as the pause it is, so its call resolves
 * `ExecutionStatus.Paused` and never rejects with a fenced refusal. A store builds it with
 * `ExecutionPauseFencedError.of(key)` for a write of the tree's root lease at or under the fenced
 * token, and for a write of one of its children's leases while the root's current token is fenced.
 * A holder that finds the pause lifted when it parks (a stale one) is handed over as before.
 */
export class ExecutionPauseFencedError extends ExecutionPausedError {
  static override readonly code = "execution.paused.fenced" as const;
  declare readonly code: typeof ExecutionPauseFencedError.code;
  override name = "ExecutionPauseFencedError";
  readonly scopeKey: string;
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly leaseExecutionId: string;
  readonly token: number;
  readonly effect: string;

  /** The refusal of the write `key` names (never throws, never names a business key). */
  static of(key: CancelFencedKey): ExecutionPauseFencedError {
    const { scopeKey, tenantId, leaseExecutionId, token, name } = key;
    const rootExecutionId = key.rootExecutionId ?? leaseExecutionId;
    return new ExecutionPauseFencedError({
      ...{ scopeKey, tenantId, leaseExecutionId, rootExecutionId, token, effect: name },
    });
  }

  constructor(options: ExecutionCancelFencedErrorOptions) {
    const { effect, rootExecutionId, cause } = options;
    super({
      message: `"${effect}" of execution ${rootExecutionId} was refused: its tree is being paused — nothing was written or sent`,
      cause,
    });
    this.scopeKey = options.scopeKey;
    this.tenantId = options.tenantId;
    this.rootExecutionId = rootExecutionId;
    this.leaseExecutionId = options.leaseExecutionId;
    this.token = options.token;
    this.effect = effect;
  }
}

/**
 * A fenced write or an outbound call was refused because its tree's `Immediate` stop is durable
 * (#1341b): nothing was written or sent. Like the cancel's refusal it is no hand-over — the lease is
 * held and the tree winds down as stopped, nothing undone; a store builds it with
 * `ExecutionStopFencedError.of(key)`.
 */
export class ExecutionStopFencedError extends ExecutionStoppedError {
  static override readonly code = "execution.stopped.fenced" as const;
  declare readonly code: typeof ExecutionStopFencedError.code;
  override name = "ExecutionStopFencedError";
  readonly scopeKey: string;
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly leaseExecutionId: string;
  readonly token: number;
  readonly effect: string;

  /** The refusal of the write `key` names (never throws, never names a business key). */
  static of(key: CancelFencedKey): ExecutionStopFencedError {
    const { scopeKey, tenantId, leaseExecutionId, token, name } = key;
    const rootExecutionId = key.rootExecutionId ?? leaseExecutionId;
    return new ExecutionStopFencedError({
      ...{ scopeKey, tenantId, leaseExecutionId, rootExecutionId, token, effect: name },
    });
  }

  constructor(options: ExecutionCancelFencedErrorOptions) {
    const { effect, rootExecutionId, cause } = options;
    super({
      message: `"${effect}" of execution ${rootExecutionId} was refused: its tree's stop was requested — nothing was written or sent`,
      cause,
    });
    this.scopeKey = options.scopeKey;
    this.tenantId = options.tenantId;
    this.rootExecutionId = rootExecutionId;
    this.leaseExecutionId = options.leaseExecutionId;
    this.token = options.token;
    this.effect = effect;
  }
}

/** The refusals of a write that end its holder's run without a hand-over: its tree's stop or pause (#1341b, #1341c). */
export type InterruptFenced = ExecutionStopFencedError | ExecutionPauseFencedError;
