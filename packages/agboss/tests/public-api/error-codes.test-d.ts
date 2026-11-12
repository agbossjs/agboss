/**
 * #906 AC2 (API review G8, completing #890), at compile time: the instance `code` of every error is
 * its class's literal, so `switch (error.code)` over a union of error instances narrows; the seven
 * parents with subclasses (`PaidStepError`, `StepFailedError`, `AgentFailedError`,
 * `LimitExceededError`, `RouterFailedError`, `DecisionError`, `ExecutionLeaseLostError`) carry the
 * literal union of their family.
 */
import { describe, expectTypeOf, it } from "vitest";
import * as a2a from "../../src/a2a/index.js";
import type { A2ATaskFailedError } from "../../src/a2a/index.js";
import * as models from "../../src/models/index.js";
import * as rag from "../../src/rag/index.js";
import * as root from "../../src/index.js";
import type {
  BusinessKeyConflictError,
  ExecutionFencedError,
  LimitExceededError,
  OutboundCallUnreconciledError,
  PaidStepError,
  StepFailedError,
  ThreadIdsExhaustedError,
  UnknownPauseError,
  BudgetExceededError,
  AgentFailedError,
  QualityGateError,
  RouterFailedError,
  DecisionError,
  ExecutionLeaseLostError,
} from "../../src/index.js";

type ErrorClassesOf<M> = {
  [
    K in keyof M as M[K] extends abstract new (...args: never) => root.AGBossError ? K : never
  ]: M[K];
};
type InstanceCodeOf<C> = C extends abstract new (...args: never) => { readonly code: infer Code }
  ? Code
  : never;
/** The exported error classes whose instance `code` is the wide `string`. */
type WideCodes<M> = {
  [K in keyof ErrorClassesOf<M>]: string extends InstanceCodeOf<ErrorClassesOf<M>[K]> ? K : never;
}[keyof ErrorClassesOf<M>];

describe("#906 AC2: the instance code is the class's literal", () => {
  it("AC2: no exported error but the base `AGBossError` has a code typed `string`", () => {
    expectTypeOf<WideCodes<typeof root>>().toEqualTypeOf<"AGBossError">();
    expectTypeOf<WideCodes<typeof a2a>>().toEqualTypeOf<never>();
    expectTypeOf<WideCodes<typeof models>>().toEqualTypeOf<never>();
    expectTypeOf<WideCodes<typeof rag>>().toEqualTypeOf<never>();
  });

  it("AC2: a leaf's instance code is its static code", () => {
    expectTypeOf<
      BusinessKeyConflictError["code"]
    >().toEqualTypeOf<"fenced-effect.business-key-conflict">();
    expectTypeOf<A2ATaskFailedError["code"]>().toEqualTypeOf<"a2a.task-failed">();
    expectTypeOf<
      OutboundCallUnreconciledError["code"]
    >().toEqualTypeOf<"outbound-call.unreconciled">();
    expectTypeOf<BudgetExceededError["code"]>().toEqualTypeOf<"limit.budget">();
    expectTypeOf<QualityGateError["code"]>().toEqualTypeOf<"step.agent.quality-gate">();
  });

  it("AC2: a parent's instance code is the literal union of its family", () => {
    expectTypeOf<ExecutionLeaseLostError["code"]>().toEqualTypeOf<
      "execution.lease-lost" | "execution.lease-lost.fenced"
    >();
    expectTypeOf<DecisionError["code"]>().toEqualTypeOf<
      "model.decision" | "model.decision.invalid-request" | "model.decision.invalid-response"
    >();
    expectTypeOf<RouterFailedError["code"]>().toEqualTypeOf<
      "step.router" | "step.router.invalid-decision"
    >();
    expectTypeOf<AgentFailedError["code"]>().toEqualTypeOf<
      "step.agent" | "step.agent.quality-gate" | "step.agent.invalid-answer"
    >();
    expectTypeOf<LimitExceededError["code"]>().toEqualTypeOf<
      | "limit"
      | "limit.budget"
      | "limit.steps"
      | "limit.visits"
      | "limit.depth"
      | "limit.deadline"
      | "limit.mesh-loop"
      | "limit.hops"
    >();
    expectTypeOf<StepFailedError["code"]>().toExtend<PaidStepError["code"]>();
    expectTypeOf<AgentFailedError["code"]>().toExtend<StepFailedError["code"]>();
    expectTypeOf<"step">().toExtend<PaidStepError["code"]>();
    expectTypeOf<"step">().not.toExtend<StepFailedError["code"]>();
  });
});

type Failure =
  | BusinessKeyConflictError
  | ThreadIdsExhaustedError
  | ExecutionFencedError
  | UnknownPauseError
  | StepFailedError;

describe("#906 AC2: switch (error.code) narrows over a union of instances", () => {
  it("AC2: each case names one class, a parent drops out of the others", () => {
    const narrowed = (error: Failure): string => {
      switch (error.code) {
        case "fenced-effect.business-key-conflict":
          expectTypeOf(error).toEqualTypeOf<BusinessKeyConflictError>();
          return error.effect;
        case "run.thread-ids-exhausted":
          expectTypeOf(error).toEqualTypeOf<ThreadIdsExhaustedError>();
          return String(error.tries);
        case "execution.lease-lost.fenced":
          expectTypeOf(error).toEqualTypeOf<ExecutionFencedError>();
          return error.scopeKey;
        case "pause.unknown":
          expectTypeOf(error).toEqualTypeOf<UnknownPauseError>();
          return error.message;
        default:
          // what is left: the step failures only
          expectTypeOf(error).toEqualTypeOf<StepFailedError>();
          return error.nodeId;
      }
    };

    expectTypeOf(narrowed).returns.toBeString();
  });
});
