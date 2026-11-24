import { describe, expect, it } from "vitest";
import type { WorkflowServices } from "../../src/workflow.js";
import { resolveTools } from "../../src/workflow.js";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import type { ToolInvocationContext } from "../../src/tools/index.js";
import { bundleWith, Handbook, HandbookFromApi } from "./fixture.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import { testFrame } from "../helpers/frame.js";

const services: WorkflowServices = {
  router: (name) => ({ name, route: () => Promise.reject(new Error("unused")) }),
};
const spent: UsageRecord[] = [];
const ctx: ToolInvocationContext = {
  signal: new AbortController().signal,
  reportCost: () => undefined,
};

/** A search runs in an execution's frame: its tenant, and where its spend goes. */
const inTestFrame = <T>(work: () => Promise<T>): Promise<T> =>
  runInFrame(
    {
      ...testFrame(),
      services: {
        reportUsage: (record) => {
          spent.push(record);
        },
      },
    },
    work,
  );

describe("knowledge bases — contract", () => {
  it("any RagSource (RagRetrieval { results }) annotated @Rag, injected into a tool, is a knowledge base that searches through the pipeline", async () => {
    const bundle = await workflowOf(bundleWith(Handbook, "tool"));
    const search = resolveTools(bundle, services).find((tool) => tool.name === "search-handbook");

    expect(bundle.config.agents["helper-agent"]).toMatchObject({
      tools: ["search-handbook"],
    });
    expect(search).toBeDefined();
    // #700: a search runs in an execution's frame (its tenant)
    expect(await inTestFrame(async () => search?.invoke({ query: "on-call" }, ctx))).toEqual({
      kind: "ok",
      value: {
        results: [
          { source: "oncall.md", text: "On-call starts after the third month." },
          { source: "leave.md", text: "Leave is 25 days a year." },
        ],
      },
    });
    // the search's cost is billed to rag:<name>, whichever tool calls it
    expect(spent.map((record) => [record.caller, record.costUsd])).toEqual([
      ["rag:handbook", 0.0002],
    ]);
  });

  it("rag: [...] gives the agent a source retrieving top-k; describe prints it; the index list has every base", async () => {
    const bundle = await workflowOf(bundleWith(Handbook, "context"));
    const [source] = bundle.knowledge?.(services).get("helper-agent") ?? [];

    expect(bundle.config.agents["helper-agent"]?.tools).toEqual([]);
    expect(bundle.config.agents["helper-agent"]?.rag).toEqual([
      { name: "handbook", topK: 2, scope: "tenant" },
    ]);
    expect(describeWorkflow(bundle)).toContain("    rag: handbook (k 2, tenant)");
    expect(source?.topK).toBe(2);
    expect(
      (await inTestFrame(async () => source?.retrieve("q", { topK: 1, signal: ctx.signal })))
        ?.results,
    ).toHaveLength(1);
    expect(bundle.knowledgeBases?.(services).map((kb) => kb.name)).toEqual(["handbook"]);
  });

  it("swapping the implementation changes nothing outside the knowledge base", async () => {
    const a = await workflowOf(bundleWith(Handbook, "tool"));
    const b = await workflowOf(bundleWith(HandbookFromApi, "tool"));
    const searchB = resolveTools(b, services).find((tool) => tool.name === "search-handbook");

    expect(b.config.agents).toEqual(a.config.agents);
    expect(await inTestFrame(async () => searchB?.invoke({ query: "on-call" }, ctx))).toEqual({
      kind: "ok",
      value: { results: [{ source: "api:handbook/42", text: "On-call: month 3." }] },
    });
  });
  it("a class in an agent's rag that is not a @Rag fails assembly with its name", async () => {
    class NotRag {
      readonly plain = true;
    }

    await expect(workflowOf(bundleWith(NotRag as never, "context"))).rejects.toThrow(
      /NotRag in an agent's rag is not a @Rag/,
    );
  });
});
