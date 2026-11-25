/**
 * #1366: the codes and the facts a step's error carries are what a caller switches on and reads: the family's
 * codes, the step's coordinates and the failure's own details (rejections of a gate, the guard's name).
 */
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect, it } from "vitest";
import { ComponentKind, bareRecordOf } from "../../../src/flow/runtime/records.js";

describe("#1366: the codes of the step errors", () => {
  it("each variant of the family has its own code on the instance, the family's `step` over it", () => {
    const agent = new StepError.Agent({ agent: "x", usage: [] });
    const gate = new StepError.QualityGate({ agent: "x", usage: [], rejections: [], retries: 0 });

    expect([agent.code, gate.code]).toEqual(["step.agent", "step.agent.quality-gate"]);
    expect(StepError.code).toBe("step");
    expect(agent).toBeInstanceOf(StepError);
    expect(gate).toBeInstanceOf(StepError);
  });
});

describe("#1366: the facts of a step error", () => {
  it("a step's failure names its coordinates in the details", () => {
    const component = bareRecordOf("x", ComponentKind.Agent);

    const error = new StepError.Agent({
      agent: "x",
      usage: [],
      component,
      nodeId: "x#2",
      visitNumber: 3,
      itemIndex: 1,
      details: { extra: true },
    });

    expect(error.details).toEqual({
      extra: true,
      agent: "x",
      component,
      nodeId: "x#2",
      visitNumber: 3,
      itemIndex: 1,
    });
  });

  it("a step error made with no coordinates names its own step at visit 0", () => {
    const error = new StepError.Action({ action: "pay-action" });

    expect(error).toMatchObject({ nodeId: "pay-action", visitNumber: 0 });
    expect(error.component).toMatchObject({ name: "pay-action", kind: ComponentKind.Action });
  });

  it("a quality gate that was not passed carries a copy of each rejection and the retries in its details", () => {
    const rejections = [
      { judge: "tone", reason: "rude" },
      { judge: "facts", reason: "wrong" },
    ];

    const error = new StepError.QualityGate({ agent: "writer", usage: [], rejections, retries: 2 });

    expect(error.details).toMatchObject({ agent: "writer", retries: 2, rejections });
    expect(error.details?.rejections).not.toBe(rejections);
    expect((error.details?.rejections as unknown[])[0]).not.toBe(rejections[0]);
    expect(error.rejections).toBe(rejections);
    expect(error.retries).toBe(2);
  });

  it("a guard that could not route names itself in the details", () => {
    const error = new StepError.Guardrail({
      guardrail: "pii-guard",
      usage: [],
      reason: "model down",
    });

    expect(error.details).toMatchObject({ guardrail: "pii-guard" });
    expect(error.guardrail).toBe("pii-guard");
    expect(error.reason).toBe("model down");
  });
});
