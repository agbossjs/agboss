import { asDeclared } from "../../src/models/model-pricing.js";
import { usd } from "../../src/units/index.js";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { costCategoryOf, recordReportedCost } from "../../src/finops/usage.js";
import { gatherKnowledge } from "../../src/graph/nodes/knowledge.js";
import type { AgentExecutionDeps } from "../../src/run/types.js";
import { createModelRegistry, type ModelFactory } from "../../src/llm/registry.js";
import { CITE_INSTRUCTION } from "../../src/prompts/rag.js";
import type { KnowledgeSource } from "../../src/rag/types.js";
import { ScriptedChatModel } from "../fakes/scripted-model.js";
import { routeTo, fakeDeps, fakeGateway, runText } from "../helpers.js";

const handbook = (retrieve: KnowledgeSource["retrieve"]): KnowledgeSource => ({
  name: "handbook",
  topK: 2,
  retrieve,
});
const found: KnowledgeSource["retrieve"] = () =>
  Promise.resolve({
    results: [{ source: "oncall.md", text: "On-call starts after the third month." }],
    costUsd: usd(0.0002),
  });

async function setup(source: KnowledgeSource) {
  const alpha = new ScriptedChatModel(["After the third month [oncall.md]."]);
  const factory = vi.fn<ModelFactory>((s) =>
    s.model === "test/alpha" ? alpha : new FakeListChatModel({ responses: ["x"] }),
  );
  const base = await fakeDeps({ "test/router": [routeTo("alpha-agent")] });
  const deps: AgentExecutionDeps<string> = {
    ...base,
    registry: createModelRegistry(base.config, fakeGateway(factory), asDeclared),
    knowledge: (agent) => (agent === "alpha-agent" ? [source] : []),
  };
  return { deps, alpha };
}

const agentInput = (model: ScriptedChatModel): string =>
  model.sent[0]?.findLast((m) => m.type === "human")?.text ?? "";

const question = "When does on-call start?";

describe("knowledge bases — context injection", () => {
  it("AC2, AC3, #141 AC4, #148 AC3: { results } with sources come before the task, with the cite instruction; cost in retrieval", async () => {
    const retrieve = vi.fn(found);
    const { deps, alpha } = await setup(handbook(retrieve));

    const result = await runText(question, deps);

    // the query is the agent's input message (#270 Q51)
    expect(retrieve).toHaveBeenCalledWith(
      expect.stringContaining(question),
      expect.objectContaining({ topK: 2 }),
    );
    expect(agentInput(alpha)).toContain(
      "Knowledge (handbook):\n[oncall.md] On-call starts after the third month.",
    );
    expect(agentInput(alpha)).toContain(CITE_INSTRUCTION);
    expect(agentInput(alpha)).toContain("Answer from these search results when they are relevant");
    expect(agentInput(alpha)).not.toContain("passages");
    expect(result.cost.byCategory.rag).toBeCloseTo(0.0002);
    expect(JSON.stringify(result.output)).toContain("[oncall.md]");
  });

  it("a retrieval failure fails the step: a broken endpoint is never a silent turn without its knowledge", async () => {
    const { deps, alpha } = await setup(handbook(() => Promise.reject(new Error("index down"))));

    await expect(runText(question, deps)).rejects.toThrow("index down");

    expect(alpha.sent).toHaveLength(0);
  });

  it("AC3: each retrieval is a named span in the trace", async () => {
    const names: string[] = [];
    class Recorder extends BaseCallbackHandler {
      name = "recorder";
      override handleChainStart(
        ...args: Parameters<NonNullable<BaseCallbackHandler["handleChainStart"]>>
      ): void {
        names.push(args[7] ?? "");
      }
    }

    await gatherKnowledge([handbook(found)], "q", { callbacks: [new Recorder()] });

    expect(names).toContain("rag:handbook");
  });

  it("a search's costs are billed to rag:<name> — category rag", () => {
    const record = recordReportedCost({ name: "handbook", costCaller: "rag:handbook" }, 0.001);

    expect(record.caller).toBe("rag:handbook");
    expect(costCategoryOf(record.caller)).toBe("rag");
    expect(costCategoryOf(recordReportedCost({ name: "exchange_rate" }, 0.001).caller)).toBe(
      "tools",
    );
  });
});
