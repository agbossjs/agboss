/**
 * #1366: what a comparison of profiles and a replay report as spent — the cost of every executed task is added,
 * so the report states what the runs cost.
 */
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { runProfile } from "../../src/eval/compare.js";
import type { EvalDeps } from "../../src/eval/eval.js";
import { replay } from "../../src/eval/replay.js";
import type { RouterEngine } from "../../src/routers/index.js";
import { executionVersions } from "../../src/run/versions.js";
import { fakeDeps, routeTo, runText } from "../helpers.js";

/** Every call of a model reports $0.5. */
class CostingModel extends FakeListChatModel {
  override async _generate(
    ...args: Parameters<FakeListChatModel["_generate"]>
  ): ReturnType<FakeListChatModel["_generate"]> {
    const result = await super._generate(...args);
    for (const generation of result.generations) {
      generation.message.response_metadata = { usage: { cost: 0.5 } };
    }
    return result;
  }
}

const models = (settings: { model: string }) =>
  new CostingModel({
    responses:
      settings.model === "test/router" ? Array(8).fill(routeTo("alpha-agent")) : ["a", "b", "c"],
  });

const judge: RouterEngine = {
  name: "judge",
  route: vi.fn(() =>
    Promise.resolve({
      kind: "decided" as const,
      decision: { next: "adequate", reason: "", confidence: 0.8 },
    }),
  ),
};

async function deps() {
  return fakeDeps({}, { chatModel: models, executionBudget: 100 });
}

describe("#1366: the cost a comparison and a replay report", () => {
  it("a profile's cost is the cost of each of its tasks, added", async () => {
    const run = await deps();
    const evaluation: EvalDeps = { turns: run.turns, budgets: run.budgets, judge };

    const outcome = await runProfile({ name: "base", deps: run, evaluation }, ["t1", "t2"]);

    expect(outcome.costUsd).toBeGreaterThan(0);
    const one = await runProfile({ name: "base", deps: run, evaluation }, ["t3"]);
    expect(outcome.costUsd).toBeCloseTo(one.costUsd * 2, 9);
  });

  it("a replay's cost includes the cost of each task it replayed", async () => {
    const run = await deps();
    await runText("Explain X", run);
    const evaluation: EvalDeps = { turns: run.turns, budgets: run.budgets, judge };

    const report = await replay(run, evaluation, {
      promptVersion: executionVersions(run).promptVersion,
      limit: 10,
    });

    expect(report.replayed).toBe(1);
    const replayed = await runText("Explain X", run);
    expect(report.costUsd).toBeGreaterThanOrEqual(replayed.cost.totalUsd);
  });
});
