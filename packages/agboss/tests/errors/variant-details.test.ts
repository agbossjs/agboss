/** #1413 M1/M2: what a variant puts into `details` — no remote or model text, the deadline as ISO text. */
import { describe, expect, it } from "vitest";
import { A2AError } from "../../src/core/error-families/a2a-errors.js";
import { StepError } from "../../src/core/error-families/step-errors.js";
import { TaskState } from "@a2a-js/sdk";
import { A2AContractRule } from "../../src/a2a/client/a2a-client-errors.js";
import { failureOf } from "../../src/a2a/client/a2a-outcome.js";

const wire = (error: Error): string =>
  JSON.stringify((error as { details?: unknown }).details ?? {});

describe("details", () => {
  it("A2AError.Contract hides the card's differences, keeps them as a fact", () => {
    const error = new A2AError.Contract({
      agent: "a",
      rule: A2AContractRule.SchemaMismatch,
      skill: "s",
      differences: ["remote-secret-property"],
    });
    expect(wire(error)).not.toContain("remote-secret-property");
    expect(error.differences).toEqual(["remote-secret-property"]);
    expect(wire(error)).toContain("schema-mismatch");
  });

  it("A2AError.OriginRefused hides the allowed origins", () => {
    const error = new A2AError.OriginRefused({
      agent: "a",
      origin: "https://x",
      allowedOrigins: ["https://internal"],
    } as never);
    expect(wire(error)).not.toContain("internal");
  });

  it("A2AError.Deadline writes deadlineAt as ISO text", () => {
    const deadlineAt = new Date("2026-01-02T03:04:05.000Z");
    const error = new A2AError.Deadline({
      agent: "a",
      taskId: "t",
      contextId: "c",
      deadlineAt,
      cancel: "sent" as never,
      isCancelled: false,
    });
    expect((error as { details?: Record<string, unknown> }).details?.deadlineAt).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  it("a remote task's raw id never reaches a fact or a detail", () => {
    const raw = "evil id with spaces <script>";
    const failure = failureOf(
      { id: raw, contextId: "c", status: { state: TaskState.TASK_STATE_FAILED } } as never,
      "a",
      false,
    );
    expect(failure).toBeInstanceOf(A2AError.TaskFailed);
    expect(wire(failure as Error)).not.toContain("evil");
    expect(JSON.stringify((failure as A2AError.TaskFailed).taskId)).not.toContain("evil");
    const malformed = failureOf({ id: raw, contextId: "c" } as never, "a", false);
    expect(wire(malformed as Error)).not.toContain("evil");
  });

  it("a router decision's and a guardrail's reason (a model's text) stay out of details", () => {
    const decision = new StepError.RouterDecision({
      nodeId: "r",
      visitNumber: 1,
      reason: "model said SECRET",
    });
    const guard = new StepError.Guardrail({ guardrail: "g", reason: "model said SECRET" });
    expect(wire(decision)).not.toContain("SECRET");
    expect(wire(guard)).not.toContain("SECRET");
    expect(decision.message).toContain("SECRET");
  });
});

describe("facts", () => {
  it("a fact given as undefined keeps its key; a paid family's spend is not overwritten by a fact", () => {
    const error = new StepError.Agent({ agent: "a", cause: "boom", usage: [] });
    expect(Object.hasOwn(error, "usage")).toBe(true);
    expect(error.spend).toBeDefined();
  });
});

describe("reserved facts (#1413 L5)", () => {
  it("a fact named like what an instance owns is refused", () => {
    for (const key of ["kind", "code", "name", "spend"])
      expect(() => new StepError.Agent({ agent: "a", [key]: "x" } as never), key).toThrow(
        TypeError,
      );
  });
});
