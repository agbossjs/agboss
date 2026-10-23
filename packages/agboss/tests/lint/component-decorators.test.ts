/**
 * #402: `agboss/no-component-state` knows every decorator of a component the container creates.
 * AC1 — `this.x = …` in a method of a class with each listed decorator is reported, one fixture per
 * decorator (a `Record` over the list: a new entry does not compile without its fixture). AC2 — every
 * class decorator a public entry exports is either in the framework's one list
 * (`src/components/component-decorators.ts`) or named below as not a component, with the reason;
 * and everything listed is exported — a new decorator fails here until it is classified.
 */
import { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import {
  COMPONENT_DECORATORS,
  type ComponentDecoratorName,
} from "../../src/components/component-decorators.js";
import { agbossPlugin } from "../../src/eslint/index.js";

const linter = new TSESLint.Linter({ configType: "flat" });

/** The rule's messages for `code`, as a project file. */
function findings(code: string): readonly string[] {
  return linter
    .verify(
      code,
      [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tseslint.parser },
          plugins: { agboss: agbossPlugin },
          rules: { "agboss/no-component-state": "error" },
        },
      ],
      "src/component.ts",
    )
    .map((message) => message.message);
}

/** A component class with `decorator` that keeps a counter on `this` in a method. */
const statefulClass = (decorator: string, method: string): string =>
  [
    decorator,
    "export class StatefulComponent {",
    "  private calls = 0;",
    `  ${method} {`,
    "    this.calls = this.calls + 1;",
    "  }",
    "}",
  ].join("\n");

/** AC1: one fixture per component decorator — its decorator line and a method of its contract. */
const FIXTURES: Readonly<Record<ComponentDecoratorName, string>> = {
  Injectable: statefulClass("@Injectable()", "lookUp(): void"),
  Tool: statefulClass(
    '@Tool({ name: "order-status-tool", description: "d", input: OrderQuery, output: OrderInfo })',
    "async run(): Promise<void>",
  ),
  Action: statefulClass(
    '@Action({ name: "charge-action", description: "d", input: { order: OrderDto } })',
    "async execute(): Promise<void>",
  ),
  Router: statefulClass(
    '@Router({ name: "credit-router", description: "d", decidedBy: DecidedBy.Code, input: { order: OrderDto }, routes: [] })',
    "route(): void",
  ),
  WorkflowFinish: statefulClass(
    '@WorkflowFinish({ name: "order-workflow-finish", description: "d", input: { order: OrderDto }, output: OrderDto })',
    "finish(): void",
  ),
  Channel: statefulClass('@Channel({ name: "slack-channel" })', "async send(): Promise<void>"),
  ReplyInterpreter: statefulClass(
    '@ReplyInterpreter({ name: "refund-reply-interpreter", description: "d", decidedBy: DecidedBy.Code })',
    "interpret(): void",
  ),
  InputGuardrail: statefulClass(
    '@InputGuardrail({ name: "length-guardrail", description: "d", decidedBy: DecidedBy.Code, refusal: "r" })',
    "check(): void",
  ),
  OutputGuardrail: statefulClass(
    '@OutputGuardrail({ name: "answer-guardrail", description: "d", decidedBy: DecidedBy.Code, refusal: "r" })',
    "check(): void",
  ),
  ToolInterceptor: statefulClass(
    '@ToolInterceptor({ name: "audit-tool-interceptor", description: "d" })',
    "beforeToolCall(): void",
  ),
  PiiPolicy: statefulClass(
    '@PiiPolicy({ name: "order-id-pii-policy", description: "d", action: PiiAction.replaceWithKind() })',
    "findMatches(): void",
  ),
  Judge: statefulClass(
    '@Judge({ name: "grounded-judge", model: "moonshotai/kimi-k2.6", reply: AnswerDto })',
    "async judge(): Promise<void>",
  ),
  Arbiter: statefulClass(
    '@Arbiter({ name: "in-range-arbiter", decidedBy: DecidedBy.Code })',
    "isInRange(): void",
  ),
  Compaction: statefulClass(
    '@Compaction({ name: "graph-compaction", description: "d", strategy: CompactionStrategy.Custom, turnsBetweenCompactions: 5 })',
    "async compact(): Promise<void>",
  ),
  Budget: statefulClass(
    '@Budget({ name: "execution-budget", scope: BudgetScope.Execution })',
    "maxSpend(): void",
  ),
  HealthCheck: statefulClass(
    '@HealthCheck({ name: "crm-health-check", timeout: seconds(2) })',
    "async check(): Promise<void>",
  ),
  ModelProvider: statefulClass(
    '@ModelProvider({ name: "local-model-provider", description: "d", serves: [/^local\\//], baseUrl: "http://localhost" })',
    "async invoke(): Promise<void>",
  ),
  McpServer: statefulClass(
    '@McpServer({ name: "files", command: "npx", args: [], tools: {} })',
    "async connect(): Promise<void>",
  ),
  McpTool: statefulClass(
    '@McpTool({ name: "read-file-tool", description: "d", server: FilesServer, input: FileRead, output: FileContent })',
    "async run(): Promise<void>",
  ),
  Rag: statefulClass(
    '@Rag({ name: "jobs-rag", description: "d" })',
    "async search(): Promise<void>",
  ),
  A2AAgent: statefulClass(
    '@A2AAgent({ name: "remote-agent", url: "http://localhost:4000" })',
    "async send(): Promise<void>",
  ),
};

describe("#402 AC1: `this.x = …` in a method of every component is reported", () => {
  it.each(COMPONENT_DECORATORS)("@%s", (decorator) => {
    expect(findings(FIXTURES[decorator])).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\`this\\.calls = …\` outside the constructor of a @${decorator}: a component is one instance`,
        ),
      ),
    ]);
  });

  it("a decorator read off a namespace (`@agboss.Budget(…)`) is known too", () => {
    const found = findings(
      statefulClass(
        '@agboss.Budget({ name: "execution-budget", scope: agboss.BudgetScope.Execution })',
        "maxSpend(): void",
      ),
    );

    expect(found).toEqual([expect.stringContaining("outside the constructor of a @Budget")]);
  });
});

/**
 * AC2: the class decorators public entries export that are not components the container creates,
 * each with why — a new decorator must land in `COMPONENT_DECORATORS` or here.
 */
const NOT_COMPONENTS: Readonly<Record<string, string>> = {
  Agent:
    "metadata of a flow node: an empty class, never instantiated (its loop is the framework's)",
  WorkflowStart: "metadata of a flow node: an empty class, never instantiated",
  Workflow: "the module: metadata only, never instantiated",
  Application: "the application: metadata only, never instantiated",
  ChannelRole: "an abstract role: its @Channel implementation is the component",
  McpExpose: "what createMcpService exposes: an empty configuration class",
  A2AExpose: "what a2aHttpListener serves (#398 PR 3): an empty configuration class",
  BindTool: "a method decorator",
  OnAnswer: "a method decorator (of a code @Arbiter)",
  EvalSuite: "an eval suite (#396): its cases and checks as metadata, never instantiated",
};

/**
 * The decorator-shaped exports of the public entries: PascalCase functions that are not classes.
 * `agboss/dto` is left out: its decorators (`@Text`, `@Integer`, …) are fields of DTO classes.
 */
async function exportedDecorators(): Promise<ReadonlyMap<string, string>> {
  const entries: Readonly<Record<string, Record<string, unknown>>> = {
    agboss: await import("../../src/index.js"),
    models: await import("../../src/models/index.js"),
    mcp: await import("../../src/mcp/index.js"),
    rag: await import("../../src/rag/index.js"),
    a2a: await import("../../src/a2a/index.js"),
    memory: await import("../../src/memory/index.js"),
    eval: await import("../../src/eval/index.js"),
    testing: await import("../../src/testing/index.js"),
  };
  const found = new Map<string, string>();
  for (const [entry, exports] of Object.entries(entries)) {
    for (const [name, value] of Object.entries(exports)) {
      const isFunction = typeof value === "function";
      const isClass = isFunction && /^class\b/.test(Function.prototype.toString.call(value));
      if (/^[A-Z]/.test(name) && isFunction && !isClass) found.set(name, entry);
    }
  }
  return found;
}

describe("#402 AC2: every component decorator exported by agboss is known to the rule", () => {
  it("each exported decorator is listed as a component or named as not one", async () => {
    const exported = await exportedDecorators();
    const listed: ReadonlySet<string> = new Set(COMPONENT_DECORATORS);
    const unclassified = [...exported.keys()].filter(
      (name) => !listed.has(name) && !(name in NOT_COMPONENTS),
    );

    expect(unclassified).toEqual([]);
  }, 60_000);

  it("everything listed is an exported decorator, and nothing is both a component and not one", async () => {
    const exported = await exportedDecorators();

    expect(COMPONENT_DECORATORS.filter((name) => !exported.has(name))).toEqual([]);
    expect(Object.keys(NOT_COMPONENTS).filter((name) => !exported.has(name))).toEqual([]);
    expect(COMPONENT_DECORATORS.filter((name) => name in NOT_COMPONENTS)).toEqual([]);
  }, 60_000);
});
