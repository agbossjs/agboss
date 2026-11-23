/**
 * #1366: the codes and the facts a step's error carries are what a caller switches on and reads: the family's
 * codes, the step's coordinates and the failure's own details (rejections of a gate, the guard's name).
 */
import { describe, expect, it } from "vitest";
import { ComponentKind, bareRecordOf } from "../../src/flow/runtime/records.js";
import {
  AgentFailedError,
  GuardFailedError,
  PaidStepError,
  QualityGateError,
  StepFailedError,
} from "../../src/graph/errors.js";

describe("#1366: the codes of the step errors", () => {
  it("each class of the family has its own code, on the instance", () => {
    const paid = new PaidStepError({ message: "m", usage: [] });
    const failed = new StepFailedError({
      message: "m",
      usage: [],
      component: bareRecordOf("x", ComponentKind.Agent),
      nodeId: "x",
      visitNumber: 1,
    });
    const agent = new AgentFailedError({ agent: "x", usage: [] });

    expect([paid.code, failed.code, agent.code]).toEqual(["step", "step.failed", "step.agent"]);
  });
});

describe("#1366: the facts of a step error", () => {
  it("a step's failure names its coordinates in the details", () => {
    const component = bareRecordOf("x", ComponentKind.Agent);

    const error = new StepFailedError({
      message: "m",
      usage: [],
      component,
      nodeId: "x#2",
      visitNumber: 3,
      itemIndex: 1,
      details: { extra: true },
    });

    expect(error.details).toEqual({
      extra: true,
      component,
      nodeId: "x#2",
      visitNumber: 3,
      itemIndex: 1,
    });
  });

  it("a quality gate that was not passed carries a copy of each rejection and the retries in its details", () => {
    const rejections = [
      { judge: "tone", reason: "rude" },
      { judge: "facts", reason: "wrong" },
    ];

    const error = new QualityGateError({ agent: "writer", usage: [], rejections, retries: 2 });

    expect(error.details).toMatchObject({ agent: "writer", retries: 2, rejections });
    expect(error.details?.rejections).not.toBe(rejections);
    expect((error.details?.rejections as unknown[])[0]).not.toBe(rejections[0]);
    expect(error.rejections).toBe(rejections);
    expect(error.retries).toBe(2);
  });

  it("a guard that could not route names itself in the details", () => {
    const error = new GuardFailedError({ guard: "pii-guard", usage: [], reason: "model down" });

    expect(error.details).toMatchObject({ guard: "pii-guard" });
    expect(error.guard).toBe("pii-guard");
    expect(error.reason).toBe("model down");
  });
});
