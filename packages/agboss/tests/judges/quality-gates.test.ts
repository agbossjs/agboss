/**
 * #185: `@Agent({ judges, maxRetries })` quality gates run — each `@Judge` is created by the
 * container with its deps, judges with its own model through the model gateway (spend in the cost
 * report), sends its reason back for a retry, and fails the run with `QualityGateError` once the
 * retries are spent. A judge without a model fails at app start.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { QualityGateError } from "../../src/errors.js";
import { replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { offline } from "../components/fixture/deps-contract.workflow.js";
import {
  Grounded,
  TaskStart,
  Writer,
  JudgedDeskApplication,
  ModellessDeskApplication,
} from "./fixtures/judged.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

/** Every text the model was sent in one request. */
const textsOf = (request: ModelRequest | undefined): string[] =>
  request?.kind === "chat"
    ? request.messages.map((line) =>
        typeof line.text === "string" ? line.text : JSON.stringify(line.text),
      )
    : [];

describe("quality gates of an agent", () => {
  const test = testWith(JudgedDeskApplication);

  test("a reply the judge passes is the answer; the judge used its own model with its deps", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer).thenReturn(replyWith("Acme is hiring a TS engineer."));
    mockLlm(Grounded).thenReturn(replyWith("PASS"));

    const result = await execute(app, TaskStart, { text: "find a TS job" });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "Acme is hiring a TS engineer." });
    expect(mockLlm(Writer).requests).toHaveLength(1);
    const asked = textsOf(mockLlm(Grounded).onlyRequest).join("\n");
    expect(asked).toContain("Is the reply grounded in the task?");
    expect(asked).toContain("Reply: Acme is hiring a TS engineer.");
  });

  test("a rejected reply is retried with the judge's reason in the agent's next model call", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer)
      .thenReturn(replyWith("Some job somewhere."))
      .thenReturn(replyWith("Acme is hiring a TS engineer."));
    mockLlm(Grounded).thenReturn(replyWith("FAIL: names no company")).thenReturn(replyWith("PASS"));

    const result = await execute(app, TaskStart, { text: "find a TS job" });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "Acme is hiring a TS engineer." });
    const [first, second] = mockLlm(Writer).requests;
    expect(textsOf(first).join("\n")).not.toContain("names no company");
    expect(textsOf(second).at(-1)).toContain("[grounded] names no company");
  });

  test("AC1: a judge that always rejects ends the run with QualityGateError carrying its reason", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer).thenReturnAlways(replyWith("Some job somewhere."));
    mockLlm(Grounded).thenReturnAlways(replyWith("FAIL: names no company"));

    const run = execute(app, TaskStart, { text: "find a TS job" });

    await expect(run).rejects.toBeInstanceOf(QualityGateError);
    await expect(run).rejects.toMatchObject({
      code: "step.agent.quality-gate",
      agent: "writer-agent",
      retries: 1,
      rejections: [{ judge: "grounded", reason: "names no company" }],
    });
    // the first reply and its one retry (maxRetries: 1), each judged
    expect(mockLlm(Writer).requests).toHaveLength(2);
    expect(mockLlm(Grounded).requests).toHaveLength(2);
  });

  test("AC2: judge calls are in the run's cost report under the judge's own model", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer).thenReturnAlways(replyWith("Acme is hiring.", { cost: usd(0.002) }));
    mockLlm(Grounded)
      .thenReturn(replyWith("FAIL: too short", { cost: usd(0.0005) }))
      .thenReturn(replyWith("PASS", { cost: usd(0.0005) }));

    const result = await execute(app, TaskStart, { text: "find a TS job" });

    const judged = result.spend.trace.filter((line) => line.caller === "judge:grounded");
    expect(judged.map((line) => line.model)).toEqual(["local/judge", "local/judge"]);
    expect(result.spend.byCategory.review).toBeCloseTo(0.001, 6);
    expect(result.spend.byModel["local/judge"]).toBeCloseTo(0.001, 6);
    expect(result.spend.totalUsd).toBeCloseTo(0.005, 6);
  });
});

describe("AC3: a judge without a model", () => {
  it("is rejected at app start with judge.no-model", async () => {
    await expect(createApp(ModellessDeskApplication, offline())).rejects.toThrow(
      /^\[judge\.no-model\] @Judge Modelless/u,
    );
  });
});
