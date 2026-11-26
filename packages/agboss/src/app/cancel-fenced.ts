import type { AGBossError } from "../core/errors.js";
import { ExecutionError } from "../core/error-families/run-errors.js";
import type { EffectKey } from "../infrastructure/effect-key.js";
import { ExecutionPauseFencedError, ExecutionStopFencedError } from "./lease-stopped.js";

/** Every fact of a write refused by its tree's cancel, a stop or a pause (#909, #906: an options bag). */
export interface ExecutionCancelFencedErrorOptions {
  /** `executionContext.fence.scopeKey` of the refused write. */
  readonly scopeKey: string;
  readonly tenantId: string;
  /** The root of the tree whose cancel refused it. */
  readonly rootExecutionId: string;
  /** The execution whose lease the write ran under (the root, or an `AnyWorker` child). */
  readonly leaseExecutionId: string;
  readonly token: number;
  /** The effect's or the call's name, never its business key. */
  readonly effect: string;
  readonly cause?: unknown;
}

/** What names a refused write: the key of the effect or the call. */
export type CancelFencedKey = Pick<
  EffectKey,
  "scopeKey" | "tenantId" | "leaseExecutionId" | "token" | "name" | "rootExecutionId"
>;

/**
 * The refusal of the write `key` names after its tree's durable cancel (#909): nothing was written
 * or sent. A cancel, not a hand-over — the lease is held and the tree unwinds as cancelled, its undo
 * running under it. A store builds it with `cancelFencedOf(key)`; never throws, never names a business key.
 */
export const cancelFencedOf = (key: CancelFencedKey): ExecutionError.CancelFenced =>
  new ExecutionError.CancelFenced({
    scopeKey: key.scopeKey,
    tenantId: key.tenantId,
    leaseExecutionId: key.leaseExecutionId,
    rootExecutionId: key.rootExecutionId ?? key.leaseExecutionId,
    token: key.token,
    effect: key.name,
  });

/**
 * The refusal of the write `key` names while its tree's `Immediate` pause fences the lease (#1341c):
 * nothing was written or sent. The core takes it as the pause it is, never as a cancel. A store builds
 * it with `pauseFencedOf(key)`; the class stays internal, so the type is `AGBossError`.
 */
export const pauseFencedOf = (key: CancelFencedKey): AGBossError =>
  ExecutionPauseFencedError.of(key);

/**
 * The refusal of the write `key` names while its tree's `Immediate` stop is durable (#1341b): nothing
 * was written or sent. The core takes it as the stop it is, never as a cancel. A store builds it with
 * `stopFencedOf(key)`; the class stays internal, so the type is `AGBossError`.
 */
export const stopFencedOf = (key: CancelFencedKey): AGBossError => ExecutionStopFencedError.of(key);
