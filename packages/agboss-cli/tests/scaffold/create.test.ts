/**
 * #268 AC8: `agboss create <project>` makes an application and its first workflow — the application
 * at `src/<project>.application.ts` (its path in package.json), its environments, budgets, model
 * provider and guardrail beside it, the workflow `<project>-workflow` in `src/<project>/` — and the
 * code follows the conventions (#280). The end-to-end checks (tsc, lint, tests) are e2e.test.ts's.
 */
import { describe, expect, it } from "vitest";
import { specFromFlags } from "../../src/scaffold/flags.js";
import type { WorkflowSpec } from "../../src/scaffold/plan.js";
import { planProject } from "../../src/scaffold/project.js";

const files = planProject(
  specFromFlags("desk", {
    yes: true,
    agents: "answerer-agent:Answers questions",
    tools: "answerer-agent:search-orders-tool",
  }) as WorkflowSpec,
);
const content = (path: string): string => files.find((file) => file.path === path)?.content ?? "";

describe("#268 AC8: agboss create", () => {
  it("an application and its first workflow, the application's path in package.json", () => {
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "src/desk.application.ts",
        "src/config/budget.config.ts",
        "src/environments/app.environment.ts",
        "src/guardrails/prompt-injection.guardrail.ts",
        "src/model-providers/openrouter.model-provider.ts",
        "src/services/api.service.ts",
        "src/desk/desk.workflow.ts",
        "src/desk/desk.workflow.test.ts",
        "src/desk/agents/answerer.agent.ts",
        "src/desk/tools/search-orders.tool.ts",
      ]),
    );
    expect(JSON.parse(content("package.json"))).toMatchObject({
      agboss: { application: "src/desk.application.ts" },
    });
    expect(content("src/desk.application.ts")).toContain('name: "desk-application",');
    expect(content("src/desk.application.ts")).toContain("workflows: [DeskWorkflow],");
    expect(content("src/desk/desk.workflow.ts")).toContain('name: "desk-workflow",');
    expect(content("src/desk/agents/answerer.agent.ts")).toContain('name: "answerer-agent",');
  });

  it("the code conventions (#280): explicit return types, implements …Handler, fields named after their type, the contexts through deps", () => {
    const tool = content("src/desk/tools/search-orders.tool.ts");
    expect(tool).toContain('name: "search-orders-tool",');
    expect(tool).toContain("implements ToolHandler<SearchOrdersQuery, SearchOrdersResult>");
    expect(tool).toContain("deps: [ExecutionContext, ApiService],");
    expect(tool).toContain("private readonly executionContext: ExecutionContext,");
    expect(tool).toContain("private readonly apiService: ApiService,");
    expect(tool).toContain('import { ApiService } from "../../services/api.service.js";');
    expect(tool).toContain("run({ query }: SearchOrdersQuery): Promise<SearchOrdersResult> {");
    const service = content("src/services/api.service.ts");
    expect(service).toContain("@Injectable({ deps: [ApplicationContext] })");
    expect(service).toContain(
      "constructor(private readonly applicationContext: ApplicationContext) {}",
    );
    expect(service).toContain("url(path: string): string {");
    expect(content("src/config/budget.config.ts")).toContain(
      "export class ExecutionBudget implements BudgetHandler {",
    );
    expect(content("src/config/budget.config.ts")).toContain("maxSpend(): Usd {");
  });
});
