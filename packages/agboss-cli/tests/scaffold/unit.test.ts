import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helpFor, usage } from "../../src/cli/usage.js";
import { ScaffoldError } from "../../src/scaffold/errors.js";
import { agentsFrom, mcpFrom, specFromFlags } from "../../src/scaffold/flags.js";
import { planGenerate } from "../../src/scaffold/generate.js";
import { toolFiles } from "../../src/scaffold/plan.js";
import { namesOf } from "../../src/scaffold/names.js";
import { planProject } from "../../src/scaffold/project.js";
import { addImport, addToArray } from "../../src/scaffold/wire.js";
import { applyChanges } from "../../src/scaffold/write.js";

const agent = `import { Agent } from "agboss";
import { KIMI } from "../models.js";

@Agent({
  name: "answerer",
  model: KIMI,
  tools: [SearchOrdersTool],
})
export class AnswererAgent {}
`;

describe("names", () => {
  it("every spelling from one name; a name must start with a letter", () => {
    expect(namesOf("Search Orders")).toEqual({
      kebab: "search-orders",
      snake: "search_orders",
      pascal: "SearchOrders",
      title: "Search orders",
    });
    expect(namesOf("searchOrders").kebab).toBe("search-orders");
    expect(() => namesOf("9lives")).toThrow(ScaffoldError);
  });
});

describe("wiring with the TypeScript Compiler API", () => {
  it("adds to an array, creates a missing property, adds the import", () => {
    const withTool = addImport(
      addToArray(agent, "a.ts", "Agent", "tools", "RefundTool"),
      "a.ts",
      "RefundTool",
      "../tools/refund.js",
    );
    const withRag = addToArray(
      agent,
      "a.ts",
      "Agent",
      "rag",
      '{ use: NotesKnowledge, mode: "tool" }',
    );

    expect(withTool).toContain("tools: [SearchOrdersTool, RefundTool]");
    expect(withTool).toContain('import { RefundTool } from "../tools/refund.js";');
    expect(withRag).toContain('rag: [{ use: NotesKnowledge, mode: "tool" }]');
    expect(addImport(agent, "a.ts", "KIMI_PRICE", "../models.js")).toContain(
      'import { KIMI, KIMI_PRICE } from "../models.js";',
    );
  });

  it("AC3: an element already there is a clash; an unexpected shape is an error naming the file", () => {
    expect(() => addToArray(agent, "a.ts", "Agent", "tools", "SearchOrdersTool")).toThrow(
      "a.ts: SearchOrdersTool is already in tools",
    );
    expect(() => addToArray("export const x = 1;", "b.ts", "Agent", "tools", "X")).toThrow(
      "b.ts: no @Agent({ … }) found",
    );
    expect(() =>
      addToArray(agent.replace("[SearchOrdersTool]", "TOOLS"), "c.ts", "Agent", "tools", "X"),
    ).toThrow("not an array literal");
  });
});

describe("writing", () => {
  it("AC3: an existing file → an error and nothing written", async () => {
    const root = await mkdtemp(join(tmpdir(), "scaffold-"));
    await writeFile(join(root, "b.ts"), "keep");

    await expect(
      applyChanges(root, {
        create: [
          { path: "a.ts", content: "a" },
          { path: "b.ts", content: "b" },
        ],
        modify: [],
      }),
    ).rejects.toThrow("Already exists: b.ts. Nothing was written");
    expect(existsSync(join(root, "a.ts"))).toBe(false);
    expect(await readFile(join(root, "b.ts"), "utf8")).toBe("keep");
  });

  it("AC3: generating a part that exists refuses before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "scaffold-"));
    await applyChanges(root, {
      create: planProject(
        specFromFlags("desk", {
          yes: true,
          agents: "answerer:Answers",
          tools: "answerer:search_orders",
        }) as never,
      ),
      modify: [],
    });

    // the clash is caught before anything is written: the files and the wiring are both there
    const again = await planGenerate(
      "tool",
      "search orders",
      { workflow: "src/desk/desk.workflow.ts", agent: "answerer" },
      root,
    );
    await expect(applyChanges(root, again)).rejects.toThrow(
      "Already exists: src/desk/tools/search-orders.tool.ts, src/desk/tools/search-orders.tool.test.ts. Already wired: src/desk/agents/answerer.agent.ts: SearchOrdersTool already in tools. Nothing was written — rerun with --force",
    );
    await expect(
      planGenerate("tool", "x", { workflow: "src/desk/desk.workflow.ts" }, root),
    ).rejects.toThrow("agboss generate tool needs --agent <name>");
    await expect(planGenerate("widget", "x", {}, root)).rejects.toThrow("Unknown kind");
  });
});

describe("flags (no questions)", () => {
  it("AC4: agents, tools, MCP and knowledge base from flags; --yes fills the rest", () => {
    expect(agentsFrom("triage:Sorts requests,answerer:Answers", "answerer:search_orders")).toEqual([
      { name: "triage", description: "Sorts requests", tools: [] },
      { name: "answerer", description: "Answers", tools: ["search_orders"] },
    ]);
    expect(mcpFrom("filesystem:/tmp/docs", "desk")).toEqual({
      kind: "filesystem",
      name: "desk files",
      dir: "/tmp/docs",
    });
    expect(mcpFrom("command:my-server:search", "desk")).toMatchObject({
      kind: "command",
      command: "my-server",
      tool: "search",
    });
    expect(() => mcpFrom("ftp", "desk")).toThrow(ScaffoldError);
    expect(() => agentsFrom("a:x", "ghost:t")).toThrow(ScaffoldError);
    expect(specFromFlags("desk", { yes: true })).toMatchObject({
      agents: [{ name: "assistant" }],
      mcp: { kind: "none" },
    });
    expect(specFromFlags("desk", { rag: "notes" }).rag).toEqual({
      name: "desk notes",
      folder: "notes",
    });
  });
});

describe("help (#93)", () => {
  it("AC5: create (c) and generate (g) are listed, with their options", () => {
    expect(usage()).toMatch(/create\s+a new project from a short questionnaire \(alias c\)/);
    expect(usage()).toMatch(
      /generate\s+add a workflow, agent, router, arbiter, tool, MCP server, knowledge base or OpenAPI tools, wired \(alias g\)/,
    );
    expect(helpFor("generate")).toContain("--agent <name>");
  });
});

describe("#280 AC11: generated code follows the conventions", () => {
  it("conventions: a tool takes the execution context through its constructor, typed and named", () => {
    const [tool, test] = toolFiles("src/desk/tools", namesOf("search orders"));
    const [apiTool] = toolFiles("src/desk/tools", namesOf("search orders"), namesOf("desk"));

    expect(tool?.content).toContain(
      "implements ToolHandler<SearchOrdersQuery, SearchOrdersResult>",
    );
    expect(tool?.content).toContain("deps: [ExecutionContext],");
    expect(tool?.content).toContain(
      "constructor(private readonly executionContext: ExecutionContext) {}",
    );
    expect(tool?.content).toContain(
      "run({ query }: SearchOrdersQuery): Promise<SearchOrdersResult> {",
    );
    expect(tool?.content).not.toMatch(/\bctx\b/u);
    expect(test?.content).toContain("new SearchOrdersTool(testExecutionContext())");
    expect(apiTool?.content).toContain("deps: [ExecutionContext, ApiService],");
    expect(apiTool?.content).toContain("private readonly apiService: ApiService,");
  });
});
