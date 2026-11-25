/**
 * #194 AC2: every error a user can catch is importable from the public entry (`agboss`), is a
 * `AGBossError` and has its own stable code. Type-checked by `tsc` (tests are in the project).
 */
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as agboss from "../../src/index.js";
import {
  AgentFailedError,
  BudgetExceededError,
  AGBossError,
  GuardFailedError,
  LimitExceededError,
  ModelCallError,
  NotPausedError,
  PaidStepError,
  RouterDecisionError,
  ToolTimeoutError,
  type ErrorRecord,
  ValidationError,
} from "../../src/index.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";

const catchable = {
  AgentFailedError,
  BudgetExceededError,
  ValidationError,
  GuardFailedError,
  LimitExceededError,
  ModelCallError,
  NotPausedError,
  PaidStepError,
  RouterDecisionError,
  ToolTimeoutError,
  ExecutionError,
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
    for (const removed of ["InsufficientFundsError", "QuorumFailedError"]) {
      expect(Object.keys(agboss)).not.toContain(removed);
    }
  });

  it("`ExecutionError` is the family of the execution's errors (#1325), not the old class", () => {
    expect(Object.keys(agboss.ExecutionError)).toContain("LeaseLost");
    expect(agboss.ExecutionError.code).toBe("execution");
  });
});
