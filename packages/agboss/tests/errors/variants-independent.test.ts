/**
 * #1325b: the variants of a family are siblings. A side path on one (`.onError(StepError.Router)`)
 * does not take another (`StepError.RouterDecision`); the family takes both.
 */
import { describe, expect, it } from "vitest";
import { codeOfErrorClass, errorMatchOf, errorRecordOf } from "../../src/core/error-record.js";
import { StepError } from "../../src/core/error-families/step-errors.js";
import { LimitError } from "../../src/core/error-families/limit-errors.js";

const takes = (error: Error, handler: Parameters<typeof codeOfErrorClass>[0]): boolean => {
  const code = codeOfErrorClass(handler);
  return code !== undefined && errorMatchOf(errorRecordOf(error), code) !== undefined;
};

describe("sibling variants", () => {
  const decision = new StepError.RouterDecision({ nodeId: "r", visitNumber: 1, reason: "no" });
  const crash = new StepError.Router({ nodeId: "r", visitNumber: 1, cause: "boom" });
  const gate = new StepError.QualityGate({ agent: "a", rejections: [], retries: 1 });
  const agent = new StepError.Agent({ agent: "a", cause: "boom" });

  it("StepError.Router does not take a RouterDecision, and the other way round", () => {
    expect(takes(decision, StepError.Router)).toBe(false);
    expect(takes(crash, StepError.RouterDecision)).toBe(false);
    expect(takes(crash, StepError.Router)).toBe(true);
    expect(takes(decision, StepError.RouterDecision)).toBe(true);
  });

  it("StepError.Agent does not take a QualityGate, and the other way round", () => {
    expect(takes(gate, StepError.Agent)).toBe(false);
    expect(takes(agent, StepError.QualityGate)).toBe(false);
  });

  it("the family takes every variant of it, and no variant of another family", () => {
    for (const error of [decision, crash, gate, agent]) expect(takes(error, StepError)).toBe(true);
    const limit = new LimitError.Agent({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: 0 as never,
    });
    expect(takes(limit, StepError)).toBe(false);
    expect(takes(limit, LimitError)).toBe(true);
    expect(takes(agent, LimitError)).toBe(false);
  });
});
