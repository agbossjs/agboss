import { usd } from "../../../src/units/index.js";
/**
 * #1366: a judge's paid file reading (each source file the model saw, read again and transcribed) is checked
 * against the budgets before every model call it makes, with the usage so far, the flow's path and the
 * loop's own spend: a budget already used up refuses the reading, no model call is made.
 */
import { describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";

const { filePiecesOf } = vi.hoisted(() => ({ filePiecesOf: vi.fn() }));
vi.mock("../../../src/files/visit-files.js", async (original) => ({
  ...(await original<typeof import("../../../src/files/visit-files.js")>()),
  filePiecesOf,
}));
vi.mock("../../../src/graph/agent-loop/model-pii.js", () => ({ loopPoliciesOf: () => undefined }));

const { judgedFilesOf } = await import("../../../src/graph/agent-loop/judge-files.js");

const record = (costUsd: number, caller: string): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const before = record(0.25, "before the loop");
const inLoop = record(0.5, "in the loop");
const state = {
  seen: [{ source: { url: "https://files.example/a" }, digest: "d1" }],
  usage: [before, inLoop],
  from: { usage: 1 },
  flowPath: ["flow", "alpha"],
  fileTranscripts: {},
  piiTokens: {},
};

describe("#1366: the judge's file reading and the budgets", () => {
  it("each model call of the reading is checked with the usage so far, the path and the loop's spend", async () => {
    const check = vi.fn();
    filePiecesOf.mockImplementation((options: { beforeModelCall: () => void }) => {
      options.beforeModelCall();
      return Promise.resolve({ viewed: [], pieces: [], usage: [] });
    });

    await judgedFilesOf(state as never, { fileRuntime: {}, budgets: { check } } as never);

    expect(check).toHaveBeenCalledExactlyOnceWith([before, inLoop], ["flow", "alpha"], [inLoop]);
  });

  it("a budget that refuses stops the reading: the error reaches the caller", async () => {
    const refusal = new Error("the budget is used up");
    const check = vi.fn(() => {
      throw refusal;
    });
    filePiecesOf.mockImplementation((options: { beforeModelCall: () => void }) => {
      options.beforeModelCall();
      return Promise.resolve({ viewed: [], pieces: [], usage: [] });
    });

    await expect(
      judgedFilesOf(state as never, { fileRuntime: {}, budgets: { check } } as never),
    ).rejects.toBe(refusal);
  });
});
