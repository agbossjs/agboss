import { usd } from "../../src/units/index.js";
/**
 * #1366: a mesh limit that a tool met fails the step with the loop's spend — its figure and its records — at
 * the loop's path, whichever of the two limits it is, so the ledger and the error agree on what the run cost.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { makeCollectNode } from "../../src/graph/agent-loop/collect-node.js";
import { HopsLimitExceededError, MeshLoopDetectedError } from "../../src/mesh/mesh-errors.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const entry = { application: "a", start: "s" };
const chain = [{ application: "b", start: "t", executionId: "e1" }];

/** The collect node of a loop that spent `usage` (its first record before the loop) when the tool answered `meshLimit`. */
function collected(meshLimit: unknown, usage: readonly UsageRecord[]): Promise<unknown> {
  const node = makeCollectNode({ agent: { name: "alpha" } } as never);
  const state = {
    move: new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name: "t", args: {}, type: "tool_call" }],
    }),
    results: { c1: { meshLimit } },
    usage,
    from: { usage: 1 },
    flowPath: ["flow", "alpha"],
    runId: "r",
  };
  return node(state as never, {} as never).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("#1366: the spend a mesh limit fails the step with", () => {
  const before = record(0.25, "before the loop");
  const inLoop = record(0.5, "in the loop");

  it("a loop met by a call chain it is already in: the whole spend's figure, the loop's own records, its path", async () => {
    const error = await collected({ code: "limit.mesh-loop", details: { entry, chain } }, [
      before,
      inLoop,
    ]);

    expect(error).toBeInstanceOf(MeshLoopDetectedError);
    expect(error).toMatchObject({ spentUsd: usd(0.75), usage: [inLoop], path: ["flow", "alpha"] });
  });

  it("the hop limit: the same figure, records and path", async () => {
    const error = await collected(
      { code: "limit.hops", details: { entry, chain, maxMeshHops: 3 } },
      [before, inLoop],
    );

    expect(error).toBeInstanceOf(HopsLimitExceededError);
    expect(error).toMatchObject({
      spentUsd: usd(0.75),
      usage: [inLoop],
      path: ["flow", "alpha"],
      maxMeshHops: 3,
    });
  });
});
