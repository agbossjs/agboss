import { RagMode } from "../../src/rag/types.js";
import { describe, expect, it } from "vitest";
import type { WorkflowServices } from "../../src/workflow.js";
import { resolveTools } from "../../src/workflow.js";
import { workflowOf } from "../../src/testing/index.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import type { ToolCallContext } from "../../src/tools/index.js";
import { bundleWith, Handbook, HandbookFromApi } from "./fixture.js";

const services: WorkflowServices = {
  router: (name) => ({ name, route: () => Promise.reject(new Error("unused")) }),
};
const costs: number[] = [];
const ctx: ToolCallContext = {
  signal: new AbortController().signal,
  reportCost: (usd) => {
    costs.push(usd);
  },
};

describe("knowledge bases — contract", () => {
  it("AC1, AC5, #141 AC4: any class implementing the contract (RagRetrieval { results }), annotated @Rag and bound by an agent, is a knowledge base", async () => {
    const bundle = await workflowOf(bundleWith(Handbook, RagMode.Tool));
    const search = resolveTools(bundle, services).find(
      (tool) => tool.name === "search-handbook-tool",
    );

    expect(bundle.config.agents["helper-agent"]).toMatchObject({
      tools: ["search-handbook-tool"],
      rag: [{ name: "handbook", mode: "tool", topK: 2 }],
    });
    expect(search?.costCaller).toBe("rag:handbook");
    expect(await search?.invoke({ query: "on-call" }, ctx)).toEqual({
      kind: "ok",
      value: {
        results: [
          { source: "oncall.md", text: "On-call starts after the third month." },
          { source: "leave.md", text: "Leave is 25 days a year." },
        ],
      },
    });
    expect(costs).toEqual([0.0002]);
    expect(describeWorkflow(bundle)).toContain("    rag: handbook (tool, k 2)");
  });

  it("#148 AC3: the search tool's description speaks of search results, not passages", async () => {
    const bundle = await workflowOf(bundleWith(Handbook, RagMode.Tool));
    const search = resolveTools(bundle, services).find(
      (tool) => tool.name === "search-handbook-tool",
    );

    expect(search?.description).toContain(
      "Returns the most relevant search results with their source; cite them as [source].",
    );
    expect(search?.description).not.toContain("passages");
  });

  it("AC1: context mode gives the agent a source retrieving top-k; the index list has every base", async () => {
    const bundle = await workflowOf(bundleWith(Handbook, RagMode.Context));
    const [source] = bundle.knowledge?.(services).get("helper-agent") ?? [];

    expect(bundle.config.agents["helper-agent"]?.tools).toEqual([]);
    expect(source?.topK).toBe(2);
    expect((await source?.retrieve("q", { topK: 1, signal: ctx.signal }))?.results).toHaveLength(1);
    expect(bundle.knowledgeBases?.(services).map((kb) => kb.name)).toEqual(["handbook"]);
  });

  it("AC4: swapping the implementation changes nothing outside the knowledge base", async () => {
    const a = await workflowOf(bundleWith(Handbook, RagMode.Tool));
    const b = await workflowOf(bundleWith(HandbookFromApi, RagMode.Tool));
    const searchB = resolveTools(b, services).find((tool) => tool.name === "search-handbook-tool");

    expect(b.config.agents).toEqual(a.config.agents);
    expect(await searchB?.invoke({ query: "on-call" }, ctx)).toEqual({
      kind: "ok",
      value: { results: [{ source: "api:handbook/42", text: "On-call: month 3." }] },
    });
  });
  it("AC5: a class in an agent's rag that is not a @Rag fails assembly with its name", async () => {
    class NotRag {
      readonly plain = true;
    }

    await expect(workflowOf(bundleWith(NotRag as never, RagMode.Tool))).rejects.toThrow(
      /NotRag in an agent's rag is not a @Rag/,
    );
  });
});
