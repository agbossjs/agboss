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
import { HttpAuthenticator } from "../../src/index.js";

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
  Application: statefulClass('@Application({ name: "app-application" })', "describe(): void"),
  Workflow: statefulClass('@Workflow({ name: "app-workflow" })', "describe(): void"),
  WorkflowStart: statefulClass(
    '@WorkflowStart({ name: "app-workflow-start" })',
    "describe(): void",
  ),
  WorkflowFinish: statefulClass(
    '@WorkflowFinish({ name: "app-workflow-finish" })',
    "describe(): void",
  ),
  Agent: statefulClass('@Agent({ name: "app-agent" })', "describe(): void"),
  Mesh: statefulClass('@Mesh({ name: "app-mesh" })', "describe(): void"),
  McpEndpoint: statefulClass('@McpEndpoint({ name: "app-mcp-endpoint" })', "describe(): void"),
  A2AEndpoint: statefulClass('@A2AEndpoint({ name: "app-a2a-endpoint" })', "describe(): void"),
  EvalSuite: statefulClass('@EvalSuite({ name: "app-eval-suite" })', "describe(): void"),
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
  Channel: statefulClass('@Channel({ name: "slack-channel" })', "async send(): Promise<void>"),
  ReplyInterpreter: statefulClass(
    '@ReplyInterpreter({ name: "refund-reply-interpreter", description: "d", decidedBy: DecidedBy.Code })',
    "interpret(): void",
  ),
  InputGuardrail: statefulClass(
    '@InputGuardrail({ name: "length-guardrail", description: "d", refusal: "r" })',
    "check(): void",
  ),
  OutputGuardrail: statefulClass(
    '@OutputGuardrail({ name: "answer-guardrail", description: "d", refusal: "r" })',
    "check(): void",
  ),
  ToolInterceptor: statefulClass(
    '@ToolInterceptor({ name: "audit-tool-interceptor", description: "d" })',
    "beforeAnyTool(): void",
  ),
  PiiPolicy: statefulClass(
    '@PiiPolicy({ name: "order-id-pii-policy", description: "d", action: PiiAction.mask() })',
    "findMatches(): void",
  ),
  Judge: statefulClass(
    '@Judge({ name: "grounded-judge", model: "moonshotai/kimi-k2.6", output: AnswerDto, deps: [JudgeModel] })',
    "async judge(): Promise<void>",
  ),
  Arbiter: statefulClass('@Arbiter({ name: "in-range-arbiter" })', "isInRange(): void"),
  Memory: statefulClass(
    '@Memory({ name: "graph-memory", description: "d", ttl: Ttl.Forever, turnsBetweenCompactions: 5 })',
    "async compact(): Promise<void>",
  ),
  Budget: statefulClass(
    '@Budget({ name: "execution-budget", scope: BudgetScope.Execution })',
    "maxSpend(): void",
  ),
  FilePolicy: statefulClass('@FilePolicy({ name: "stateful-file-policy" })', "describe(): void"),
  HealthCheck: statefulClass(
    '@HealthCheck({ name: "crm-health-check", timeout: seconds(2) })',
    "async check(): Promise<void>",
  ),
  ToolApproval: statefulClass(
    '@ToolApproval({ name: "refund-tool-approval", description: "d", respondent: PauseRespondent.Owner, timeout: hours(1) })',
    "assign(): void",
  ),
  ExternalTask: statefulClass(
    '@ExternalTask({ name: "limit-external-task", description: "d", input: AskDto, output: AnswerDto, respondent: PauseRespondent.Owner, timeout: hours(1) })',
    "permitAnswer(): void",
  ),
  ChannelSelector: statefulClass(
    "@ChannelSelector({ target: RefundToolApproval })",
    "selectChannel(): void",
  ),
  ChannelInterpreter: statefulClass("@ChannelInterpreter()", "interpret(): void"),
  ChannelListener: statefulClass("@ChannelListener()", "onPauseOpened(): void"),
  HttpAuthenticator: statefulClass("@HttpAuthenticator()", "authenticate(): void"),
  Observer: statefulClass('@Observer({ name: "desk-observer" })', "onExecutionEnd(): void"),
  PauseListener: statefulClass(
    '@PauseListener({ name: "back-office-pause-listener" })',
    "async onPauseClosed(): Promise<void>",
  ),
  WorkingCalendar: statefulClass(
    '@WorkingCalendar({ name: "office-working-calendar" })',
    "async addWorkingTime(): Promise<void>",
  ),
  DatabaseStorage: statefulClass(
    '@DatabaseStorage({ name: "app-database-storage", driver: SqliteDriver.inMemory(), auditLogTtl: hours(24), ledgerEntriesTtl: hours(24) })',
    "async ping(): Promise<void>",
  ),
  ClusterStorage: statefulClass(
    '@ClusterStorage({ name: "app-cluster-storage", driver: redis })',
    "async ping(): Promise<void>",
  ),
  ObjectStorage: statefulClass(
    '@ObjectStorage({ name: "app-object-storage", driver: InMemoryObjectDriver() })',
    "async ping(): Promise<void>",
  ),
  ModelProvider: statefulClass(
    '@ModelProvider({ name: "local-model-provider", description: "d", serves: [/^local\\//], baseUrl: "http://localhost" })',
    "async invoke(): Promise<void>",
  ),
  McpServer: statefulClass(
    '@McpServer({ name: "files", command: "npx", args: [], tools: {} })',
    "async connect(): Promise<void>",
  ),
  Rag: statefulClass(
    '@Rag({ name: "jobs-rag", description: "d" })',
    "async search(): Promise<void>",
  ),
  RagReranker: statefulClass(
    '@RagReranker({ name: "jobs-reranker", description: "d", candidates: 5 })',
    "async rerank(): Promise<void>",
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
  ChannelRole: "an abstract role: its @Channel implementation is the component",
  Arbitrate: "a method decorator (of a code @Arbiter)",
  SqliteDriver: "a driver factory (#1321): settings for a storage component, not a class",
  S3Driver: "a driver factory (#1321): settings for a storage component, not a class",
  LocalDiskDriver: "a driver factory (#1321): settings for a storage component, not a class",
  InMemoryObjectDriver: "a driver factory (#1321): settings for a storage component, not a class",
  DecisionsDriver: "a driver factory (#1313): settings for a model provider, not a class",
  OpenAiCompatibleDriver: "a driver factory (#1313): settings for a model provider, not a class",
  OpenRouterDriver: "a driver factory (#1313): settings for a model provider, not a class",
  BeforeTool: "a method decorator (of a @ToolInterceptor)",
  AfterTool: "a method decorator (of a @ToolInterceptor)",
};

/**
 * The decorator-shaped exports of the public entries: PascalCase functions that are not classes.
 * `@agboss/core/dto` is left out: its decorators (`@Text`, `@Integer`, …) are fields of DTO classes.
 */
async function exportedDecorators(): Promise<ReadonlyMap<string, string>> {
  const entries: Readonly<Record<string, Record<string, unknown>>> = {
    agboss: await import("../../src/index.js"),
    models: await import("../../src/models/index.js"),
    mcp: await import("../../src/mcp/index.js"),
    rag: await import("../../src/rag/index.js"),
    a2a: await import("../../src/a2a/index.js"),
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
