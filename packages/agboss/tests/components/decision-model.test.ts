import { describe, expect, it, vi } from "vitest";
import { Decision } from "../../src/index.js";
import { LiveDecisionModel, type DecisionService } from "../../src/components/decision-model.js";
import { SpendOutsideStepError } from "../../src/components/spend-recorder.js";
import { withDecisionSpend } from "../../src/finops/failed-decision.js";
import { inToolCallFrame, runInFrame } from "../../src/flow/context/frame.js";
import { testExecutionContext } from "../../src/testing/index.js";
import { usageRecord } from "../helpers.js";

const request = {
  state: { text: "3 results" },
  questions: { route: Decision.boolean("relevant?") },
};

function frameOf(signal?: AbortSignal) {
  const agent = testExecutionContext({ executionId: "exec-1" });
  const { executionId, threadId, ownerId, workflow, tenant } = agent;
  return {
    execution: {
      executionId,
      threadId,
      ownerId,
      signal: signal ?? agent.signal,
      workflow,
      tenant,
      values: {},
    },
    step: agent.step,
  };
}

const answering: DecisionService = () =>
  Promise.resolve({
    answers: { route: { probability: 0.9 } },
    usage: usageRecord("decision:x", 0.01),
  }) as unknown as ReturnType<DecisionService>;

describe("DecisionModel (#1313)", () => {
  it("answers, and the call's cost is the tool call's spend", async () => {
    const reportUsage = vi.fn();
    const model = new LiveDecisionModel("tool:x", answering);

    const answers = await runInFrame(frameOf(), () =>
      inToolCallFrame("call_1", { reportUsage }, () => model.decide(request)),
    );

    expect(answers).toEqual({ route: { probability: 0.9 } });
    expect(reportUsage).toHaveBeenCalledOnce();
  });

  it("a billed answer that cannot be used is still spent", async () => {
    const reportUsage = vi.fn();
    const billed = usageRecord("decision:x", 0.02);
    const error = new Error("bad");
    withDecisionSpend(error, billed); // an object carries its record itself
    const failing: DecisionService = () => Promise.reject(error);
    const model = new LiveDecisionModel("tool:x", failing);

    await expect(
      runInFrame(frameOf(), () =>
        inToolCallFrame("call_1", { reportUsage }, () => model.decide(request)),
      ),
    ).rejects.toThrow("bad");

    expect(reportUsage).toHaveBeenCalledWith(billed);
  });

  it("an exhausted budget (an aborted signal) stops it before any request", async () => {
    const service = vi.fn(answering);
    const model = new LiveDecisionModel("tool:x", service);
    const exhausted = new AbortController();
    exhausted.abort(new RangeError("budget exhausted"));

    await expect(
      runInFrame(frameOf(exhausted.signal), () =>
        inToolCallFrame("call_1", { reportUsage: vi.fn() }, () => model.decide(request)),
      ),
    ).rejects.toThrow("budget exhausted");

    expect(service).not.toHaveBeenCalled();
  });

  it("outside a step there is no execution to bill: refused, nothing asked", async () => {
    const service = vi.fn(answering);

    await expect(new LiveDecisionModel("tool:x", service).decide(request)).rejects.toBeInstanceOf(
      SpendOutsideStepError,
    );
    expect(service).not.toHaveBeenCalled();
  });
});
