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

  it("#305 AC3: AGENTS.md with the routing table, a one-line CLAUDE.md, the skills with their manifest and header", () => {
    const paths = files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/skills/agboss/SKILL.md",
        ".claude/skills/agboss/.agboss-skills.json",
        ".claude/skills/agboss/references/01-composition-and-architecture.md",
        ".claude/skills/agboss/references/12-end-to-end-recipes.md",
      ]),
    );
    expect(
      paths.filter((path) => path.startsWith(".claude/skills/agboss/references/")),
    ).toHaveLength(12);
    expect(content("CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(content("AGENTS.md")).toContain("# Desk — instructions for coding agents");
    expect(content("AGENTS.md")).toContain("application (`src/desk.application.ts`)");
    expect(content("AGENTS.md")).toContain(
      "`.claude/skills/agboss/references/11-cli-studio-and-error-catalog.md`",
    );
    expect(content("AGENTS.md")).toMatch(/## Project rules\n$/);
    const manifest = JSON.parse(content(".claude/skills/agboss/.agboss-skills.json")) as {
      version: string;
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toHaveLength(13);
    expect(content(".claude/skills/agboss/SKILL.md")).toContain(
      `<!-- agboss-skills-version: ${manifest.version} — managed by \`agboss check\``,
    );
    expect(files.find((file) => file.path === ".claude/skills/agboss/SKILL.md")?.isVerbatim).toBe(
      true,
    );
    expect(content(".gitignore")).toContain("\n.claude/skills/agboss/\n");
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
