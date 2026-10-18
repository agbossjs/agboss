/**
 * #194 AC2: every error a user can catch is importable from the public entry (`agboss`), is a
 * `AGBossError` and has its own stable code. Type-checked by `tsc` (tests are in the project).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import * as agboss from "../../src/index.js";
import {
  AgentFailedError,
  BudgetExceededError,
  DtoValidationError,
  AGBossError,
  GuardFailedError,
  LimitExceededError,
  ModelCallError,
  NotPausedError,
  PaidStepError,
  RouterDecisionError,
  ToolTimeoutError,
  UnknownThreadError,
  ExecutionCancelledError,
  type ErrorRecord,
} from "../../src/index.js";

const catchable = {
  AgentFailedError,
  BudgetExceededError,
  DtoValidationError,
  GuardFailedError,
  LimitExceededError,
  ModelCallError,
  NotPausedError,
  PaidStepError,
  RouterDecisionError,
  ToolTimeoutError,
  UnknownThreadError,
  ExecutionCancelledError,
};

describe("#194 AC2: the errors a user can catch come from the public entry", () => {
  it("each is a AGBossError class with its own code", () => {
    for (const cls of Object.values(catchable)) {
      expectTypeOf(cls.prototype).toExtend<AGBossError>();
      expect(cls.prototype).toBeInstanceOf(AGBossError);
    }
    const codes = Object.values(catchable).map((cls) => cls.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(agboss)).toEqual(expect.arrayContaining(Object.keys(catchable)));
  });

  it("the record type is public", () => {
    expectTypeOf<ErrorRecord>().toHaveProperty("code").toEqualTypeOf<string>();
    expect(agboss.errorRecordOf(new ExecutionCancelledError()).code).toBe("execution.cancelled");
  });

  it("the classes without a failure site are gone", () => {
    for (const removed of ["ExecutionError", "InsufficientFundsError", "QuorumFailedError"]) {
      expect(Object.keys(agboss)).not.toContain(removed);
    }
  });
});
