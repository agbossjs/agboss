import { describe, expect, it } from "vitest";
import { DtoValidationError } from "../src/dto/errors.js";
import { ExecutionStatus } from "../src/app/types.js";
import { executeAgent } from "../src/index.js";
import { routeTo, fakeDeps, runText } from "./helpers.js";

const deps = () =>
  fakeDeps({
    "test/router": [routeTo("alpha-agent")],
    "test/alpha": ["42"],
  });

describe("executeAgent", () => {
  it("returns the finish's output, the path and the cost report", async () => {
    const result = await runText("Answer", await deps());

    expect(result).toMatchObject({
      status: ExecutionStatus.Finished,
      finish: "answer-workflow-finish",
      output: { text: "42" },
      path: ["chat-workflow-start", "main-router", "alpha-agent", "answer-workflow-finish"],
      budgetUsd: 1,
    });
    expect(result.cost.calls).toBe(2);
  });

  it("rejects an invalid start input before the first step", async () => {
    await expect(
      executeAgent({ start: "chat-workflow-start", input: { text: 3 } }, await deps()),
    ).rejects.toBeInstanceOf(DtoValidationError);
  });
});
