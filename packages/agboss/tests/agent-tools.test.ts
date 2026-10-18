import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { LimitExceededError } from "../src/graph/limits.js";
import {
  BudgetScope,
  ROUTER_FACTORY,
  Tool,
  type RouterEngine,
  type ToolHandler,
} from "../src/index.js";
import { Text } from "../src/dto/index.js";
import { ScriptedChatModel, type Reply } from "./fakes/scripted-model.js";
import { Clock } from "./fixtures/test-workflow/test.workflow.js";
import { toolWorkflowOf } from "./fixtures/test-flow/star.workflow.js";
import { fakeDeps, memoryLedger, runText } from "./helpers.js";

interface Setup {
  readonly alpha: readonly Reply[];
  readonly maxToolCalls?: number;
  readonly runCost?: number;
  readonly toolCostUsd?: number;
}

class SearchQuery {
  @Text({ prompt: "what to look for", default: "" })
  query!: string;
}

class SearchResults {
  @Text()
  text!: string;
}

/** What one decision of the paid search's router costs (set per test). */
const paid = { costUsd: 0.01 };

/** Jev's answer to the paid search's decision, at `paid.costUsd`. */
const paidDecision = () =>
  Promise.resolve({
    model: "typesafe/jev-test",
    answers: { route: { choice: "relevant" } },
    usage: { cost: paid.costUsd },
  });

/** A paid tool: one `ROUTER_FACTORY` decision per call — its spend is the tool's (#280). */
@Tool({
  name: "paid_search",
  description: "Paid search",
  input: SearchQuery,
  output: SearchResults,
  deps: [ROUTER_FACTORY],
})
class PaidSearch implements ToolHandler<SearchQuery, SearchResults> {
  private readonly ranker: RouterEngine;

  constructor(routers: (name: string) => RouterEngine) {
    this.ranker = routers("ranker");
  }

  async run(_input: SearchQuery): Promise<SearchResults> {
    await this.ranker.route({
      input: "3 results",
      options: [
        { name: "relevant", description: "the results answer the query" },
        { name: "noise", description: "they do not" },
      ],
    });
    return { text: "3 results" };
  }
}

/** The execution budget of `setup` (`runCost`) is what stopped the execution. */
const EXECUTION_BUDGET_SPENT = {
  code: "limit.budget",
  budget: { name: "test-execution-budget" },
  scope: BudgetScope.Execution,
};

async function setup({ alpha, maxToolCalls = 3, runCost = 1, toolCostUsd = 0.01 }: Setup) {
  paid.costUsd = toolCostUsd;
  const model = new ScriptedChatModel(alpha);
  const ledger = memoryLedger();
  const workflow = toolWorkflowOf({ tools: [Clock, PaidSearch], maxToolCalls });
  const deps = await fakeDeps(
    {},
    {
      workflow,
      ledger,
      executionBudget: runCost,
      jevClient: paidDecision,
      chatModel: (settings) =>
        settings.model === "test/alpha" ? model : new FakeListChatModel({ responses: [] }),
    },
  );
  return { deps, model, ledger };
}

const toTokyo: Reply = [{ tool: "current_time", args: { timeZone: "Asia/Tokyo" } }];

describe("agents with tools", () => {
  it("runs the model ↔ tool loop and answers", async () => {
    const { deps, model } = await setup({ alpha: [toTokyo, "It is evening in Tokyo."] });

    const result = await runText("Time in Tokyo?", deps);

    expect(result.output).toEqual({ text: "It is evening in Tokyo." });
    expect(model.sent[1]?.at(-1)?.text).toContain('"timeZone":"Asia/Tokyo"');
  });

  it("lets the model see tool errors", async () => {
    const { deps, model } = await setup({
      alpha: [
        [{ tool: "current_time", args: { timeZone: "Mars/Olympus" } }],
        "Unknown zone, sorry.",
      ],
    });

    await runText("Time on Mars?", deps);

    expect(model.sent[1]?.at(-1)?.text).toContain("Tool error:");
  });

  it("records each model call of the loop", async () => {
    const { deps } = await setup({ alpha: [toTokyo, "Done."] });

    const result = await runText("Time?", deps);

    expect(result.cost.byCaller["alpha-agent"]).toBeCloseTo((2 * (100 * 3 + 20 * 6)) / 1_000_000);
  });

  it("handles two tool calls in one model reply", async () => {
    const both: Reply = [
      { tool: "current_time", args: { timeZone: "Asia/Tokyo" } },
      { tool: "current_time", args: { timeZone: "Europe/London" } },
    ];
    const { deps, model } = await setup({ alpha: [both, "Both zones."] });

    const result = await runText("Tokyo and London?", deps);

    expect(result.output).toEqual({ text: "Both zones." });
    expect(model.sent[1]?.filter((message) => message.type === "tool")).toHaveLength(2);
  });

  it("#150 AC7: maxToolCalls fails the run at agents.<name>.limits.toolCalls, the agent's spend recorded", async () => {
    const { deps, ledger } = await setup({ alpha: [toTokyo, toTokyo, "never"], maxToolCalls: 1 });

    const failure = await runText("Loop", deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LimitExceededError);
    expect(failure).toMatchObject({
      key: "agents.alpha-agent.limits.toolCalls",
      limit: 1,
      actual: 2,
      path: ["chat-workflow-start", "alpha-agent"],
    });
    expect(
      ledger.recorded.filter((record) => record.caller === "alpha-agent").length,
    ).toBeGreaterThan(0);
  });

  it("stops the loop when the execution budget is spent: the next call fails with it", async () => {
    const { deps, model, ledger } = await setup({
      alpha: [toTokyo, "never sent"],
      runCost: 0.0004,
    });

    const failure = runText("Time?", deps);

    await expect(failure).rejects.toMatchObject(EXECUTION_BUDGET_SPENT);
    expect(model.sent).toHaveLength(1);
    expect(ledger.recorded.map((record) => record.caller)).toContain("alpha-agent");
  });
});

const search: Reply = [{ tool: "paid_search", args: {} }];

describe("tool costs in FinOps", () => {
  it("reports tool costs separately", async () => {
    const { deps } = await setup({ alpha: [search, "Found it."] });

    const result = await runText("Search", deps);

    expect(result.cost.byCaller["tool:paid_search"]).toBeCloseTo(0.01);
  });

  it("stops after a paid tool spends the execution budget", async () => {
    const { deps, model } = await setup({ alpha: [search, "never sent"], runCost: 0.005 });

    await expect(runText("Search", deps)).rejects.toMatchObject(EXECUTION_BUDGET_SPENT);
    expect(model.sent).toHaveLength(1);
  });

  it("records tool spend of a failed agent", async () => {
    const { deps, ledger } = await setup({ alpha: [search, search, "never"], maxToolCalls: 1 });

    await expect(runText("Loop", deps)).rejects.toBeInstanceOf(LimitExceededError);
    expect(ledger.recorded.some((record) => record.caller === "tool:paid_search")).toBe(true);
  });
});
