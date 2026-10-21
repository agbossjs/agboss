import { describe, expect, it, vi } from "vitest";
import { BUDGET_EXHAUSTED, type EvalDeps } from "../../src/eval/eval.js";
import { BudgetScope } from "../../src/budgets/budget.js";
import { replay } from "../../src/eval/replay.js";
import { executionVersions } from "../../src/index.js";
import type { RouterEngine } from "../../src/routers/index.js";
import { routeTo, fakeDeps, memoryLedger, runText } from "../helpers.js";
import { usd } from "../../src/units/index.js";

const judgeWith = (...confidences: number[]): RouterEngine => {
  const route = vi.fn<RouterEngine["route"]>();
  for (const confidence of confidences) {
    route.mockResolvedValueOnce({
      kind: "decided",
      decision: { next: "adequate", reason: "", confidence },
    });
  }
  return { name: "judge", route };
};

describe("replay", () => {
  it("re-runs old tasks (their start lines) with the current prompts and compares scores", async () => {
    const script = {
      "test/router": [routeTo("alpha-agent"), routeTo("alpha-agent")],
      "test/alpha": ["old answer", "new answer"],
    };
    const deps = await fakeDeps(script);
    await runText("Explain X", deps);
    const oldVersion = executionVersions(deps).promptVersion;
    const changed = {
      ...deps,
      prompts: { ...deps.prompts, "alpha-agent": "You are alpha, now precise." },
    };
    const evaluation: EvalDeps = {
      terns: deps.terns,
      budgets: deps.budgets,
      judge: judgeWith(0.6, 0.9),
    };

    const report = await replay(changed, evaluation, {
      promptVersion: oldVersion,
      limit: 10,
    });

    expect(report).toMatchObject({ tasks: 1, replayed: 1, before: 0.6, after: 0.9 });
    const rows = await deps.terns.summary("test-bundle-workflow");
    expect(rows.map((row) => row.promptVersion)).toContain(
      executionVersions(changed).promptVersion,
    );
  });

  it("stops replaying when the application's budget is spent (its last known limit)", async () => {
    const ledger = memoryLedger();
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["a"] },
      { ledger },
    );
    await runText("T", deps);
    const application = {
      budget: "test-application-daily-budget",
      scope: BudgetScope.Application,
      key: "test-application",
    };
    await ledger.saveMaxSpend(application, usd(0));
    const evaluation: EvalDeps = { terns: deps.terns, budgets: deps.budgets, judge: judgeWith() };

    const report = await replay(deps, evaluation, {
      promptVersion: executionVersions(deps).promptVersion,
      limit: 10,
    });

    expect(report).toMatchObject({ replayed: 0, stoppedBy: BUDGET_EXHAUSTED });
  });
});
