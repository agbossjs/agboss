import { describe, expect, it } from "vitest";
import { routeTo, fakeDeps, runText } from "../helpers.js";

describe("executeAgent writes Terns", () => {
  it("records a finished run: its start line, its finish line, the path and the versions", async () => {
    const deps = await fakeDeps({ "test/router": [routeTo("alpha-agent")], "test/alpha": ["42"] });

    const result = await runText("Answer", deps);

    const [turn] = await deps.turns.byIds([result.turnId]);
    expect(turn).toMatchObject({
      threadId: result.threadId,
      task: 'start chat-workflow-start: {"text":"Answer"}',
      replyWith: 'finish answer-workflow-finish: {"text":"42"}',
      status: "answered",
      route: ["chat-workflow-start", "main-router", "alpha-agent", "answer-workflow-finish"],
      replayOf: null,
    });
  });

  it("records a failed run too", async () => {
    const deps = await fakeDeps({});

    await expect(runText("Anything", deps)).rejects.toThrow();

    const [turn] = await deps.turns.unscored("test-bundle-workflow", undefined, 10);
    expect(turn).toBeUndefined();
    expect((await deps.turns.summary("test-bundle-workflow"))[0]).toMatchObject({
      turns: 1,
      scored: 0,
    });
  });
});
