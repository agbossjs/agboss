import { usd } from "../../src/units/index.js";
/**
 * #1366: the validation attempts a traced step states — the most of the step's own and of its tool calls'.
 */
import { describe, expect, it } from "vitest";
import { executionTraceOf } from "../../src/eval/run/trace-of.js";

const stepOf = (validationAttempts: number) => ({
  component: { name: "desk-agent", kind: "agent" },
  nodeId: "desk-agent",
  visitNumber: 1,
  copyNumber: 1,
  itemIndex: undefined,
  toolLoopIteration: undefined,
  validationAttempts,
});

const toolCall = (validationAttempts: number) => ({
  step: {
    ...stepOf(validationAttempts),
    component: { name: "t", kind: "tool" },
    nodeId: "desk-agent",
  },
  input: {},
  output: undefined,
  status: "succeeded",
  isResultTruncated: false,
});

const attemptsOf = (own: number, calls: readonly number[]): number | undefined =>
  executionTraceOf({
    executionId: "e",
    handledErrors: [],
    record: {
      path: [],
      scope: [],
      outdatedValues: [],
      spend: { trace: [], totalUsd: usd(0), byCategory: {} },
      children: [],
      pauses: [],
      compensations: [],
      toolCalls: calls.map(toolCall),
      steps: [
        {
          step: stepOf(own),
          inputHash: "h",
          judgeVerdicts: [],
          guardrailDecisions: [],
          spend: { trace: [], totalUsd: usd(0), byCategory: {} },
          startedAt: "2026-01-05T09:00:00.000Z",
          endedAt: "2026-01-05T09:00:01.000Z",
        },
      ],
    },
  } as never).steps[0]?.validationAttempts;

describe("#1366: a traced step's validation attempts", () => {
  it("are the most of its own and its tool calls'", () => {
    expect(attemptsOf(2, [5, 1])).toBe(5);
    expect(attemptsOf(4, [1, 2])).toBe(4);
    expect(attemptsOf(3, [])).toBe(3);
  });
});
