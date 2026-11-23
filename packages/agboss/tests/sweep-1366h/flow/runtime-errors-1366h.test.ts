/**
 * #1366: the runtime errors keep their facts as fields and details (visits key and figures, attempts, a guardrail's
 * refusal, key and sureness); a step's own error passes a limit, a cancel and a pause through, and nothing else.
 */
import { GraphInterrupt } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { ExecutionCancelledError } from "../../../src/core/errors.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";
import {
  AgentAnswerInvalidError,
  GuardrailBlockedError,
  passesThrough,
  VisitsLimitExceededError,
} from "../../../src/flow/runtime/errors.js";

describe("#1366: runtime errors", () => {
  it("a visits limit is keyed by its node and carries its figures in its details", () => {
    const component = bareRecordOf("router-1", ComponentKind.Router);
    const error = new VisitsLimitExceededError({
      component,
      maxVisits: 3,
      path: ["a"],
      spentUsd: 0,
    });

    expect(error.key).toBe("router-1.maxVisits");
    expect(error.details).toEqual({
      key: "router-1.maxVisits",
      limit: 3,
      actual: 4,
      component,
      nodeId: "router-1",
      maxVisits: 3,
      visits: 4,
    });
  });

  it("an invalid-answer error keeps its attempts in its details", () => {
    const error = new AgentAnswerInvalidError({ agent: "writer", attempts: 3, usage: [] });

    expect(error.attempts).toBe(3);
    expect(error.details).toMatchObject({ agent: "writer", attempts: 3 });
  });

  it("a guardrail block keeps its refusal, key, sureness and threshold", () => {
    const error = new GuardrailBlockedError({
      guard: "pii",
      refusal: "Withheld.",
      usage: [],
      probability: 0.9,
      threshold: 0.7,
    });

    expect(error.key).toBe("guardrails.pii.threshold");
    expect(error.details).toEqual({
      guard: "pii",
      refusal: "Withheld.",
      key: "guardrails.pii.threshold",
      probability: 0.9,
      threshold: 0.7,
    });
  });

  it("passesThrough takes a pause, a limit and a cancel, and nothing else", () => {
    expect(passesThrough(new GraphInterrupt([]))).toBe(true);
    expect(
      passesThrough(
        new LimitExceededError({ key: "k", limit: 1, actual: 2, path: [], spentUsd: 0 }),
      ),
    ).toBe(true);
    expect(passesThrough(new ExecutionCancelledError())).toBe(true);
    expect(passesThrough(new Error("boom"))).toBe(false);
    expect(passesThrough("x")).toBe(false);
  });
});
