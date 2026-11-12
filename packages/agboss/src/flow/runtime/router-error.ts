import { currentFrame } from "../context/frame.js";
import { bareRecordOf, ComponentKind, plainRecordOf, type ComponentRecord } from "./records.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { RouteOutcome } from "../../routers/index.js";
import { StepFailedError } from "../../graph/errors.js";

/**
 * A router's two failures (#280 S19), mirroring `AgentFailedError` / `AgentAnswerInvalidError`:
 * it could not decide (`RouterFailedError`, the original error as its `cause`), or what it decided is
 * not allowed (`RouterDecisionError`). Both name the router's step and are caught by `.onError` right
 * after the router; matching goes through the cause chain, so the domain error inside is caught too.
 */

/** The visit of a router an error belongs to (its step). */
export interface RouterVisit {
  /** The router's node id (its `name`). */
  readonly nodeId: string;
  /** The pass through the router in the execution, from 1. */
  readonly visitNumber: number;
  /** The router's record (#268 S93); absent = its step's, read from the frame it fails in. */
  readonly component?: ComponentRecord;
}

/** The router's record: given, else its step's when it fails in its frame, else without hashes. */
function routerRecordOf(step: RouterVisit): ComponentRecord {
  if (step.component !== undefined) return step.component;
  const frame = currentFrame();
  const isOwn = frame !== undefined && !frame.isClosed() && frame.step.nodeId === step.nodeId;
  return isOwn
    ? plainRecordOf(frame.step.component)
    : bareRecordOf(step.nodeId, ComponentKind.Router);
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** What a router's failure takes (#906): its visit, the spend and what failed. */
export interface RouterFailedErrorOptions extends RouterVisit {
  readonly usage?: readonly UsageRecord[];
  /** What failed: `route()`'s error, or the model call's. */
  readonly cause?: unknown;
  /** A subclass's own sentence; `Router "<nodeId>" failed: <cause>` by default. */
  readonly message?: string;
}

/** A router could not decide: `route()` threw, or its model call failed (`cause` = the original). */
export class RouterFailedError extends StepFailedError {
  static override readonly code: string = "step.router";
  declare readonly code: "step.router" | "step.router.invalid-decision";
  override name = "RouterFailedError";

  constructor(options: RouterFailedErrorOptions) {
    const { nodeId, visitNumber, usage = [], cause } = options;
    super({
      message: options.message ?? `Router "${nodeId}" failed: ${describe(cause)}`,
      usage,
      cause,
      component: routerRecordOf(options),
      nodeId,
      visitNumber,
    });
  }
}

/** What a router's decision that is not allowed takes (#906). */
export interface RouterDecisionErrorOptions extends RouterVisit {
  /** What was wrong with the answer. */
  readonly reason: string;
  readonly usage?: readonly UsageRecord[];
  readonly cause?: unknown;
}

/**
 * A router's answer is not allowed: a target outside its routes, a list after `.chooseOne(…)`, an
 * empty list without an `Always` route, an unknown or unreadable answer from its model. Never retried.
 */
export class RouterDecisionError extends RouterFailedError {
  static override readonly code = "step.router.invalid-decision" as const;
  declare readonly code: typeof RouterDecisionError.code;
  override name = "RouterDecisionError";
  /** What was wrong with the answer. */
  readonly reason: string;

  constructor(options: RouterDecisionErrorOptions) {
    const { reason, ...visit } = options;
    super({ ...visit, message: `Router "${options.nodeId}" decided wrongly: ${reason}` });
    this.reason = reason;
  }
}

/** A model router's failed outcome as its step's error: the call failed, or the answer is not allowed. */
export function routerFailureOf(
  step: RouterVisit,
  outcome: Extract<RouteOutcome, { kind: "failed" }>,
  spent: readonly UsageRecord[] = [],
): RouterFailedError {
  const usage = [...spent, ...(outcome.usage === undefined ? [] : [outcome.usage])];
  return outcome.cause === undefined
    ? new RouterDecisionError({ ...step, reason: outcome.reason, usage })
    : new RouterFailedError({ ...step, cause: outcome.cause, usage });
}
