import { describe, expect, it, vi } from "vitest";
import { pairwise, runProfile, type ProfileOutcome } from "../../src/eval/compare.js";
import {
  configDiff,
  formatComparison,
  percentile,
  profileReport,
} from "../../src/eval/compare-report.js";
import { BUDGET_EXHAUSTED, type EvalDeps } from "../../src/eval/eval.js";
import { BudgetScope } from "../../src/budgets/budget.js";
import type { RouteOutcome, RouterEngine } from "../../src/routers/index.js";
import { routeTo, fakeDeps, memoryLedger, usageRecord } from "../helpers.js";

const judgeSaying = (outcome: RouteOutcome): RouterEngine => ({
  name: "judge",
  route: vi.fn(() => Promise.resolve(outcome)),
});

const adequate = (confidence: number): RouteOutcome => ({
  kind: "decided",
  decision: { next: "adequate", reason: "", confidence },
  usage: usageRecord("router:judge", 0.00004),
});

/** A run of the star with the test budgets; `spentToday` already spent by the tenant `default`. */
async function profileRun(name: string, spentToday = 0) {
  const ledger = memoryLedger();
  const today = new Date().toISOString().slice(0, 10);
  const tenant = { budget: "test-tenant-daily-budget", scope: BudgetScope.Tenant, key: "default" };
  if (spentToday > 0)
    await ledger.saveAll([{ ...tenant, period: today }], [usageRecord("earlier", spentToday)]);
  const deps = await fakeDeps(
    {
      "test/router": Array.from({ length: 4 }, () => routeTo("alpha-agent")),
      "test/alpha": ["x", "y"],
    },
    { ledger },
  );
  const evaluation: EvalDeps = {
    terns: deps.terns,
    budgets: deps.budgets,
    judge: judgeSaying(adequate(0.8)),
  };
  return { run: { name, deps, evaluation }, ledger };
}

describe("compare — per profile", () => {
  it("AC4, AC5: runs every task within the application's budgets, scores, costs and times it", async () => {
    const { run, ledger } = await profileRun("base");
    let now = 0;

    // a golden task is a start line (#272 S8); a plain text goes to the text start
    const tasks = ['start chat-workflow-start: {"text":"t1"}', "t2"];

    const outcome = await runProfile(run, tasks, () => (now += 100));

    expect(outcome).toMatchObject({
      name: "base",
      version: "1.0.0",

      scores: [0.8, 0.8],
      failed: 0,
    });
    expect(outcome.answers).toHaveLength(2);
    expect(outcome.latenciesMs).toEqual([100, 100]);
    expect(ledger.recorded.filter((record) => record.caller === "router:judge")).toHaveLength(2);
  });

  it("AC5: stops cleanly when the tenant's day is spent", async () => {
    const { run } = await profileRun("base", 1000);

    const outcome = await runProfile(run, ["t1", "t2"]);

    expect(outcome).toMatchObject({ answers: [], stoppedBy: BUDGET_EXHAUSTED });
  });
});

describe("compare — pairwise", () => {
  const base: ProfileOutcome = {
    name: "base",
    version: "1",
    answers: ["a1", "a2", "a3", undefined],
    scores: [],
    costUsd: 0,
    latenciesMs: [],
    failed: 0,
  };
  const other: ProfileOutcome = { ...base, name: "v2", answers: ["b1", "b2", "b3", "b4"] };
  const evaluationWith = async (...outcomes: RouteOutcome[]): Promise<EvalDeps> => {
    const route = vi.fn<RouterEngine["route"]>();
    outcomes.forEach((o) => route.mockResolvedValueOnce(o));
    return { terns: (await fakeDeps({})).terns, judge: { name: "judge", route } };
  };
  const pick = (next: string, confidence: number): RouteOutcome => ({
    kind: "decided",
    decision: { next, reason: "", confidence },
  });

  it("#396 Q10: each task judged in both orders — agreeing verdicts win or lose, a flip is a tie", async () => {
    const evaluation = await evaluationWith(
      // t1: other better in both orders — a win
      pick("second", 0.9),
      pick("first", 0.9),
      // t2: answer 1 in both orders — the position, not the answer: a tie and a flip
      pick("first", 0.9),
      pick("first", 0.9),
      // t3: baseline better first, unsure the other way — a tie, no flip
      pick("first", 0.9),
      pick("second", 0.55),
    );

    const result = await pairwise(evaluation, ["t1", "t2", "t3", "t4"], base, other);

    expect(result).toEqual({ wins: 1, losses: 0, ties: 2, positionFlips: 1 });
    const inputs = vi.mocked(evaluation.judge.route).mock.calls.map(([request]) => request.input);
    expect(inputs).toHaveLength(6);
    expect(inputs[0]).toContain("Answer 1:\na1\n\nAnswer 2:\nb1");
    expect(inputs[1]).toContain("Answer 1:\nb1\n\nAnswer 2:\na1");
  });

  it("#396 Q10: the baseline better in both orders is a loss; a failed judge is a tie", async () => {
    const evaluation = await evaluationWith(
      pick("first", 0.9),
      pick("second", 0.9),
      { kind: "failed", reason: "no answer" },
      pick("first", 0.9),
      pick("second", 0.9),
      pick("first", 0.9),
    );

    const result = await pairwise(evaluation, ["t1", "t2", "t3"], base, other);

    expect(result).toEqual({ wins: 1, losses: 1, ties: 1, positionFlips: 0 });
  });
});

describe("compare — report", () => {
  it("AC4: shows what differs between profiles, without prompt texts or the version", async () => {
    const a = await fakeDeps({});
    const alpha = a.config.agents["alpha-agent"];
    if (alpha === undefined) throw new Error("the star has alpha-agent");
    const b = {
      ...a,
      config: {
        ...a.config,
        version: "1.0.0-x",
        agents: { ...a.config.agents, "alpha-agent": { ...alpha, thinking: "low" as const } },
      },
      prompts: { ...a.prompts, "alpha-agent": "changed" },
    };

    const diff = configDiff(a, b);

    expect(diff).toContain('agents.alpha-agent.thinking: — → "low"');
    expect(diff).toContain("prompts.alpha-agent: changed");
    expect(diff.some((line) => line.startsWith("version"))).toBe(false);
  });

  it("AC4: a table row per profile with mean, pairwise, cost, latency and the diff", () => {
    const outcome: ProfileOutcome = {
      name: "v2",
      version: "1.0.0-x",
      answers: ["a", "b"],
      scores: [0.8, 0.6],
      costUsd: 0.02,
      latenciesMs: [1000, 3000],
      failed: 0,
    };

    const row = profileReport(outcome, { wins: 2, losses: 0, ties: 0, positionFlips: 1 }, [
      'agents.alpha.thinking: — → "low"',
    ]);
    const lines = formatComparison(2, [{ ...row, name: "base", pairwise: null, diff: [] }, row]);

    expect(row).toMatchObject({
      meanScore: 0.7,
      costPerTaskUsd: 0.01,
      latencyP50Ms: 1000,
      latencyP95Ms: 3000,
    });
    expect(lines).toContain(
      "v2 | 1.0.0-x | 0.70 | 2/0/0, flips 1 | $0.0200 | $0.0100 | 1.0 | 3.0 | 0",
    );
    expect(lines).toContain('  agents.alpha.thinking: — → "low"');
    expect(percentile([], 50)).toBeNull();
  });
});
