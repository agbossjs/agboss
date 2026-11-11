import { describe, expect, it } from "vitest";
import { RouterDecisionError } from "../../../src/index.js";
import { fakeDeps, memoryLedger, recordingRouters, routeTo, runText } from "../../helpers.js";
import { ROUTES } from "../../fixtures/test-flow/test.flow.js";

describe("#272: a model router decides on its input only", () => {
  it("sends its routes sorted by target name, its prompt as instructions, its input message", async () => {
    const { deps, requests } = recordingRouters(
      await fakeDeps({ "test/router": [routeTo("beta-agent")], "test/beta": ["ok"] }),
    );

    const result = await runText("hello", deps);

    expect(result.path).toEqual([
      "chat-workflow-start",
      "main-router",
      "beta-agent",
      "answer-workflow-finish",
    ]);
    expect(requests[0]?.options).toEqual([
      { name: "alpha-agent", description: ROUTES.alpha },
      { name: "beta-agent", description: ROUTES.beta },
      { name: "no-answer-workflow-finish", description: ROUTES.answer },
    ]);
    expect(requests[0]?.instructions).toBe("Pick who handles the task.");
    expect(requests[0]?.input).toBe(
      '### message (from chat-workflow-start)\n{\n  "text": "hello"\n}',
    );
  });

  it("a chat-model router decides from the model's JSON and records its usage", async () => {
    const ledger = memoryLedger();
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["hi"] },
      { ledger },
    );

    await runText("hello", deps);

    expect(ledger.recorded.map((record) => record.caller)).toEqual([
      "router:main-router",
      "alpha-agent",
    ]);
  });

  it("an option that is not a route fails the run with RouterDecisionError and a failed Turn", async () => {
    const deps = await fakeDeps({ "test/router": [routeTo("ghost-agent")] });

    const run = runText("hello", deps);

    await expect(run).rejects.toBeInstanceOf(RouterDecisionError);
    await expect(run).rejects.toMatchObject({
      code: "step.router.invalid-decision",
      nodeId: "main-router",
      visitNumber: 1,
    });
    const [summary] = await deps.terns.summary("test-bundle-workflow");
    expect(summary).toMatchObject({ terns: 1 });
  });

  it("a model reply that is not a decision is an invalid decision, not retried (S19)", async () => {
    const deps = await fakeDeps({ "test/router": ["not json", routeTo("alpha-agent")] });

    await expect(runText("hello", deps)).rejects.toMatchObject({
      code: "step.router.invalid-decision",
      reason: "invalid router output",
    });
  });
});
