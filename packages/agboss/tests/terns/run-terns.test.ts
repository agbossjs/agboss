import { describe, expect, it } from "vitest";
import { routeTo, fakeDeps, runText } from "../helpers.js";

describe("executeAgent writes Terns", () => {
  it("records a finished run: its start line, its finish line, the path and the versions", async () => {
    const deps = await fakeDeps({ "test/router": [routeTo("alpha-agent")], "test/alpha": ["42"] });

    const result = await runText("Answer", deps);

    const [tern] = await deps.terns.byIds([result.ternId]);
    expect(tern).toMatchObject({
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

    const [tern] = await deps.terns.unscored("test-bundle-workflow", undefined, 10);
    expect(tern).toBeUndefined();
    expect((await deps.terns.summary("test-bundle-workflow"))[0]).toMatchObject({
      terns: 1,
      scored: 0,
    });
  });
});
