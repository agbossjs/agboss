import { ExecutionCancelledError } from "../core/errors.js";
import { ExecutionStoppedError } from "../app/lease-stopped.js";
import type {
  ExecutionTree,
  ExecutionTreeRepository,
  ExecutionTreeValue,
} from "../infrastructure/execution-tree.repository.js";
import { InterruptMode } from "./interrupt-types.js";
import type { ExecutionLeases } from "./execution-leases.js";

/**
 * An operator's request to end a tree early, as the tree's keys and its lease row keep it
 * (#1341b): a cancel (`@agboss/cancel-request`, #360) or a stop (`@agboss/stop-request`). The key
 * is what every holder, take and look reads; the lease row's mark (`requestCancel`, `requestStop`)
 * is the durable fence behind it and the fallback when the key is not there (a request that died
 * between the two writes). `Cancel > Stop`: with both, the cancel is the request.
 */

/** The reserved key of a cancel request: `@agboss/` tree keys belong to the framework. */
export const CANCEL_REQUEST_KEY = "@agboss/cancel-request";

/** What an operator asked for. */
export enum InterruptKind {
  Cancel = "cancel",
  Stop = "stop",
}

/** A request found: its kind, how it reaches a step in flight, and the reason it was given. */
export interface InterruptRequest {
  readonly kind: InterruptKind;
  /** A cancel is always `Immediate`; a stop may be `AfterStep`. */
  readonly mode: InterruptMode;
  readonly reason?: string | undefined;
}

/** The value of a request key: when, by whom, and (a stop's) how and why. */
export interface RequestValue {
  /** `Stop` for a stop's request; none for a cancel's, whose value is as it was before #1341b. */
  readonly kind?: InterruptKind;
  readonly requestedAt: string;
  readonly ownerId: string | null;
  readonly mode?: InterruptMode;
  readonly reason?: string | undefined;
}

/** The value a request key keeps: the fields it has, never an `undefined`. */
export const requestValueOf = (request: RequestValue): ExecutionTreeValue => ({
  ...(request.kind === InterruptKind.Stop ? { kind: request.kind } : {}),
  requestedAt: request.requestedAt,
  ownerId: request.ownerId,
  ...(request.mode === undefined ? {} : { mode: request.mode }),
  ...(request.reason === undefined ? {} : { reason: request.reason }),
});

const fieldOf = (value: ExecutionTreeValue, field: string): ExecutionTreeValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, ExecutionTreeValue>>)[field]
    : undefined;

/** The request a key's value says: a stop names itself, any other value is a cancel (as before #1341b). */
function requestOf(value: ExecutionTreeValue): InterruptRequest {
  const kind =
    fieldOf(value, "kind") === InterruptKind.Stop ? InterruptKind.Stop : InterruptKind.Cancel;
  const mode = fieldOf(value, "mode");
  const reason = fieldOf(value, "reason");
  return {
    kind,
    mode:
      kind === InterruptKind.Stop && mode === InterruptMode.AfterStep
        ? InterruptMode.AfterStep
        : InterruptMode.Immediate,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

/**
 * The request the tree's keys hold, cancel first; `undefined` when there is none or a store error
 * hides it (asked again later — a read that fails never ends a tree).
 */
export async function interruptOf(
  trees: ExecutionTreeRepository,
  tree: ExecutionTree,
  leases?: Pick<ExecutionLeases, "isCancelRequested">,
): Promise<InterruptRequest | undefined> {
  try {
    // one key holds the first request, a cancel or a stop: one read, as a cancel alone always took
    const found = await trees.findByIdInTree(tree, CANCEL_REQUEST_KEY);
    if (found === undefined) return undefined;
    const request = requestOf(found);
    // `Cancel > Stop`: a stop's key is outranked by a cancel that came after it, marked on the lease row
    const isOutranked =
      request.kind === InterruptKind.Stop && (await leases?.isCancelRequested(tree)) === true;
    return isOutranked ? { kind: InterruptKind.Cancel, mode: InterruptMode.Immediate } : request;
  } catch {
    return undefined;
  }
}

/**
 * The request the tree's lease row holds (#1117, #1341b): the durable marks, read when the keys
 * hold none — a cancel or a stop that died between its mark and its key. A store error reads as none.
 */
export async function markedInterruptOf(
  leases: Pick<ExecutionLeases, "markedOf">,
  tree: ExecutionTree,
): Promise<InterruptRequest | undefined> {
  try {
    const { isCancelRequested, stop } = await leases.markedOf(tree);
    if (isCancelRequested) return { kind: InterruptKind.Cancel, mode: InterruptMode.Immediate };
    return stop === undefined ? undefined : { kind: InterruptKind.Stop, mode: stop.mode };
  } catch {
    return undefined;
  }
}

/** The operator's reason as an error keeps it: in `details`, which no report ever prints. */
const detailsOf = (
  reason: string | undefined,
): { readonly details?: { readonly reason: string } } =>
  reason === undefined ? {} : { details: { reason } };

/** The operator's reason a cancel or stop error carries, when it was given one. */
export function reasonOfError(error: unknown): string | undefined {
  const reason = error instanceof ExecutionCancelledError ? error.details?.reason : undefined;
  return typeof reason === "string" ? reason : undefined;
}

/** Why a thread's execution ends: the abort reason of its run, and what its output and record say. */
export const interruptErrorOf = (
  request: Pick<InterruptRequest, "kind" | "reason">,
  threadId: string,
  place = "",
): ExecutionCancelledError =>
  request.kind === InterruptKind.Stop
    ? new ExecutionStoppedError({
        message: `thread "${threadId}" was stopped${place}`,
        ...detailsOf(request.reason),
      })
    : new ExecutionCancelledError({
        message: `thread "${threadId}" was cancelled${place}`,
        ...detailsOf(request.reason),
      });

/** Whether `error` is a stop (or caused by one): the end that undoes nothing. */
export function isStop(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause)
    if (current instanceof ExecutionStoppedError) return true;
  return false;
}

/** How a request reaches the step in flight: a stop's mode is read from its lease mark, where it escalates. */
export async function stopModeOf(
  request: InterruptRequest,
  leases: Pick<ExecutionLeases, "stopOf"> | undefined,
  tree: ExecutionTree,
): Promise<InterruptMode> {
  if (request.kind !== InterruptKind.Stop || leases === undefined) return request.mode;
  const marked = await leases.stopOf(tree).catch(() => undefined);
  return marked?.mode ?? request.mode;
}

/**
 * Why the tree ends: the request its keys hold, else its lease row's marks (a request that died
 * between its mark and its key). One nothing can read is a cancel, as every request was before stop.
 */
export async function interruptCauseOf(
  parts: { readonly trees: ExecutionTreeRepository; readonly leases: ExecutionLeases },
  tree: ExecutionTree,
  threadId: string,
): Promise<ExecutionCancelledError> {
  const request =
    (await interruptOf(parts.trees, tree, parts.leases)) ??
    (await markedInterruptOf(parts.leases, tree));
  return interruptErrorOf(request ?? { kind: InterruptKind.Cancel }, threadId);
}

/** The reason a stopped execution's record gives (#1341b). */
export const STOPPED_STOP_REASON = "the run was stopped";
