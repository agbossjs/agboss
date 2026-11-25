import { StepError } from "../../core/error-families/step-errors.js";
import type { ComponentRecord } from "./records.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { RouteOutcome } from "../../routers/index.js";

/**
 * A router's two failures (#280 S19), mirroring `StepError.Agent` / `StepError.AgentAnswerInvalid`:
 * it could not decide (`StepError.Router`, the original error as its `cause`), or what it decided is
 * not allowed (`StepError.RouterDecision`). Both name the router's step and are caught by `.onError` right
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

/** A model router's failed outcome as its step's error: the call failed, or the answer is not allowed. */
export function routerFailureOf(
  step: RouterVisit,
  outcome: Extract<RouteOutcome, { kind: "failed" }>,
  spent: readonly UsageRecord[] = [],
): StepError.Router | StepError.RouterDecision {
  const usage = [...spent, ...(outcome.usage === undefined ? [] : [outcome.usage])];
  return outcome.cause === undefined
    ? new StepError.RouterDecision({ ...step, reason: outcome.reason, usage })
    : new StepError.Router({ ...step, cause: outcome.cause, usage });
}
