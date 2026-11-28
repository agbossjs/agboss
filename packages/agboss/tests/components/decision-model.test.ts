import { describe, expect, it, vi } from "vitest";
import { Decision } from "../../src/index.js";
import { LiveDecisionModel, type DecisionService } from "../../src/components/decision-model.js";
import { SpendOutsideStepError } from "../../src/components/spend-recorder.js";
import { withDecisionSpend } from "../../src/finops/failed-decision.js";
import { inToolCallFrame, runInFrame } from "../../src/flow/context/frame.js";
import { testExecutionContext } from "../../src/testing/index.js";
import { usageRecord } from "../helpers.js";
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { inRunOnce } from "../../src/app/idempotency-scope.js";

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
    answers: { route: { type: "boolean", probability: 0.9 } },
    usage: usageRecord("decision:x", 0.01),
  });

describe("DecisionModel (#1313)", () => {
  it("answers, and the call's cost is the tool call's spend", async () => {
    const reportUsage = vi.fn();
    const model = new LiveDecisionModel("tool:x", answering);

    const answers = await runInFrame(frameOf(), () =>
      inToolCallFrame("call_1", { reportUsage }, () => model.decide(request)),
    );

    expect(answers).toEqual({ route: { type: "boolean", probability: 0.9 } });
    expect(reportUsage).toHaveBeenCalledOnce();
    expect(reportUsage).toHaveBeenCalledWith(usageRecord("decision:x", 0.01));
  });

  it("asks the service under the cost caller decision:<consumer>, with the call's own options", async () => {
    const service = vi.fn(answering);
    const model = new LiveDecisionModel("tool:x", service);

    await runInFrame(frameOf(), () =>
      inToolCallFrame("call_1", { reportUsage: vi.fn() }, () =>
        model.decide(request, { model: "fast" }),
      ),
    );

    expect(service).toHaveBeenCalledWith({
      caller: "decision:tool:x",
      options: { model: "fast" },
      request,
    });
  });

  it("an application with no gateway for decisions fails closed, nothing reported", async () => {
    const reportUsage = vi.fn();
    const model = new LiveDecisionModel("tool:x", undefined);

    await expect(
      runInFrame(frameOf(), () =>
        inToolCallFrame("call_1", { reportUsage }, () => model.decide(request)),
      ),
    ).rejects.toThrow("no model gateway for decisions");
    expect(reportUsage).not.toHaveBeenCalled();
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

  it("the injected model is frozen", () => {
    expect(Object.isFrozen(new LiveDecisionModel("tool:x", answering))).toBe(true);
  });

  it("inside a runOnce it is refused as a call that could be paid twice, naming the consumer and the effect", async () => {
    const service = vi.fn(answering);
    const model = new LiveDecisionModel("tool:x", service);

    const error = await inRunOnce("make-order", () =>
      runInFrame(frameOf(), () =>
        inToolCallFrame("call_1", { reportUsage: vi.fn() }, () => model.decide(request)),
      ),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(IdempotencyError.ExternalCallInTransaction);
    expect((error as Error).message).toContain(
      'DecisionModel.decide of tool:x inside runOnce "make-order"',
    );
    expect(service).not.toHaveBeenCalled();
  });

  it("outside a step the refusal names the consumer and says what to do", async () => {
    const error = await new LiveDecisionModel("tool:x", answering)
      .decide(request)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SpendOutsideStepError);
    expect((error as Error).message).toBe(
      "[spend.outside-step] tool:x asked a decision outside a step or a tool call — ask it while the step (or the tool call) runs, so its cost has an execution to be billed to",
    );
  });

  it("in a step's frame with nothing to report to, or in a frame that has closed, it is refused the same way", async () => {
    const service = vi.fn(answering);
    const model = new LiveDecisionModel("tool:x", service);
    let late: Promise<unknown> = Promise.resolve();

    const bare = await runInFrame(frameOf(), () => model.decide(request)).catch(
      (thrown: unknown) => thrown,
    );
    await runInFrame(frameOf(), () =>
      inToolCallFrame("call_1", { reportUsage: vi.fn() }, () => {
        late = new Promise((resolve) => setTimeout(resolve, 5)).then(() => model.decide(request));
        return Promise.resolve();
      }),
    );
    const closed = await late.catch((thrown: unknown) => thrown);

    expect(bare).toBeInstanceOf(SpendOutsideStepError);
    expect(closed).toBeInstanceOf(SpendOutsideStepError);
    expect(service).not.toHaveBeenCalled();
  });

  it("a failure that billed nothing reports nothing: no empty entry in the spend", async () => {
    const reportUsage = vi.fn();
    const failure = new Error("refused");
    const model = new LiveDecisionModel("tool:x", () => Promise.reject(failure));

    await expect(
      runInFrame(frameOf(), () =>
        inToolCallFrame("call_1", { reportUsage }, () => model.decide(request)),
      ),
    ).rejects.toBe(failure);

    expect(reportUsage).not.toHaveBeenCalled();
  });
});
