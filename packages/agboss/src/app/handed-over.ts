import { ExecutionStopFencedError } from "./lease-stopped.js";
import { currentFrame, type FrameLease, type FrameSpec } from "../flow/context/frame.js";
import { nodeEventOf } from "../flow/observers/execution-event.js";
import type { HandOverSite } from "../infrastructure/execution-audit-log.repository.js";
import { ApplicationStoppingError } from "../core/errors.js";
import { ExecutionError, isHandOverError } from "../core/error-families/run-errors.js";
import { ExecutionCancelFencedError, ExecutionLeaseLostError } from "./lease-lost.js";

/**
 * Work that stopped without failing (#265): its instance lost the tree's lease
 * (`ExecutionLeaseLostError`), or stopped and interrupted it (`ApplicationStoppingError`, the
 * shutdown timeout passed), or an external system fenced one of its writes (`ExecutionError.Fenced`,
 * #471 — found anywhere in the error's cause chain). Another instance continues the tree: it reaches
 * neither `.onError` nor the record (which stays `running`), and the tree keeps its keys.
 */
export const isHandedOver = (error: unknown): boolean =>
  error instanceof ExecutionLeaseLostError ||
  error instanceof ApplicationStoppingError ||
  isHandOverError(error) ||
  fencedErrorOf(error) !== undefined;

/** A write an external system refused (#471): a store's `ExecutionError.Fenced`, or the family's (#1317c). */
export type FencedRefusalError = ExecutionError.Fenced;

/** The ways work is handed over: its lease lost, its instance stopping, a write of it fenced. */
export type HandedOver = ExecutionLeaseLostError | ApplicationStoppingError | ExecutionError.Fenced;

/** Why a signal stopped the work, when it was handed over; `undefined` otherwise. */
export function handedOverReason(signal: AbortSignal | undefined): HandedOver | undefined {
  const reason: unknown = signal?.aborted === true ? signal.reason : undefined;
  return reason instanceof ExecutionLeaseLostError ||
    reason instanceof ApplicationStoppingError ||
    reason instanceof ExecutionError.Fenced
    ? reason
    : undefined;
}

/**
 * The fenced refusal behind `error` (#471): the error itself, or one in its `cause` chain or an
 * `AggregateError`'s `errors` (a driver that wraps it, `Promise.any`) — cycles are walked once. The
 * error found is returned as it is: `fence.fencedError()`'s `ExecutionError.Fenced` (#1317c) stays
 * the family's, never rebuilt as another class.
 */
export const fencedErrorOf = (error: unknown): FencedRefusalError | undefined =>
  errorOfClass(error, ExecutionError.Fenced) ?? errorOfClass(error, ExecutionError.Fenced);

/**
 * The `ExecutionCancelFencedError` behind `error` (#909): the error itself, or one in its `cause`
 * chain or an `AggregateError`'s `errors` — a store's refusal of a write after its tree's cancel,
 * however a driver or a step wrapped it.
 */
export const cancelFencedErrorOf = (
  error: unknown,
): ExecutionCancelFencedError | ExecutionStopFencedError | undefined =>
  errorOfClass(error, ExecutionCancelFencedError) ?? errorOfClass(error, ExecutionStopFencedError);

/**
 * A step under `lease` met its tree's cancel in `error` (#909): `tell` it (the audit row and the
 * observer first), then the holder stops the tree as cancelled; nothing for any other error.
 */
export function cancelMet(
  error: unknown,
  lease: Pick<FrameLease, "cancelFound">,
  tell: () => void,
): void {
  const cancelled = cancelFencedErrorOf(error);
  if (cancelled === undefined) return;
  tell();
  lease.cancelFound?.(cancelled);
}

/** The first error of `type` in `error`'s cause chain (an `AggregateError`'s too); cycles are walked once. */
function errorOfClass<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): T | undefined {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const next = pending.shift();
    // `undefined` and `null` are neither errors nor of `type`: they fall through every check below
    if (seen.has(next)) continue;
    seen.add(next);
    if (next instanceof type) return next;
    if (next instanceof AggregateError) pending.push(...(next.errors as unknown[]));
    if (next instanceof Error) pending.push(next.cause);
  }
  return undefined;
}

/** What stops the lease a fenced write ran under (`execution-leases.ts` registers each held one). */
type FencedHolder = (error: FencedRefusalError) => void;

/** Keyed by scope and token; `undefined`, a holder's key before it holds, is never a key here. */
const holders = new Map<string | undefined, FencedHolder>();

const holderKeyOf = (scopeKey: string, token: number): string => `${scopeKey}#${String(token)}`;

/**
 * The held lease of one scope as the holder a fenced write of its token stops (`stop`): `hold(token)`
 * at each take, `forget()` once it is released, lost or yielded.
 */
export class FencedHolders {
  #key: string | undefined;

  constructor(
    private readonly scopeKey: string,
    private readonly stop: FencedHolder,
  ) {}

  hold(token: number): void {
    this.forget();
    this.#key = holderKeyOf(this.scopeKey, token);
    holders.set(this.#key, this.stop);
  }

  readonly forget = (): void => {
    if (holders.get(this.#key) === this.stop) holders.delete(this.#key);
    this.#key = undefined;
  };
}

/**
 * Why the work stopped when it was handed over (#471): a fenced error behind `error` first — its
 * holder's lease aborted with it, so the signal and every later check agree —, then the signal's
 * hand-over; `undefined` for a failure of the work. A fenced error wins over an older reason of the
 * signal (the lease's own expiry a moment before), so the moving call rejects with the fenced error.
 */
export function handedOverOf(
  error: unknown,
  signal: AbortSignal | undefined,
): HandedOver | undefined {
  const fenced = fencedErrorOf(error);
  if (fenced === undefined) return handedOverReason(signal);
  holders.get(holderKeyOf(fenced.scopeKey, fenced.token))?.(fenced);
  return fenced;
}

/** The lease scopes each hand-over error was recorded for (#501): once per error and scope. */
const recorded = new WeakMap<HandedOver, Set<string>>();

/**
 * `handedOver`, recorded first (#501): its row of the audit log and `onStepHandedOver`, for the
 * step of `frame` (the current one by default) — once per error and lease scope, so the innermost
 * site records it and the sites it is rethrown through do not. Nothing without a frame or a lease
 * that records (a unit runner, an ancestor rebuilt elsewhere).
 */
export function recordedHandOver<T extends HandedOver>(
  handedOver: T,
  site: HandOverSite,
  frame: FrameSpec | undefined = currentFrame(),
): T {
  if (frame === undefined) return handedOver;
  const { lease } = frame.execution;
  if (lease?.recordHandOver === undefined) return handedOver;
  const scopes = recorded.get(handedOver) ?? new Set<string>();
  if (scopes.has(lease.scopeKey)) return handedOver;
  recorded.set(handedOver, scopes.add(lease.scopeKey));
  lease.recordHandOver({ event: nodeEventOf(frame), error: handedOver, site });
  return handedOver;
}
