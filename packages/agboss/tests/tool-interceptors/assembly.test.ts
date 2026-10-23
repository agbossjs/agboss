/**
 * #384 — tool interceptors at assembly, in `agboss describe` and in `configHash`: the chains of the
 * four levels with their excludes, `[tool-interceptor.not-an-interceptor]`,
 * `[tool-interceptor.exclude-not-inherited]`, `[tool-interceptor.missing-handler]`,
 * `[name.kind-suffix]`, a class without either method does not compile.
 */
import { describe, expect, it } from "vitest";
import {
  Agent,
  GraphRuleError,
  Tool,
  ToolCallDecision,
  ToolInterceptor,
  Workflow,
  type ToolHandler,
} from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import { nodesOf } from "../../src/describe/snapshot-nodes.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { configSnapshot } from "../../src/run/versions.js";
import type { AssembledWorkflow } from "../../src/workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { ShopApplication } from "../guardrails/code-guardrails.fixture.js";
import { ScoutAnswer, ScoutApplication, ScoutStart } from "./application.fixture.js";
import {
  AuditToolInterceptor,
  CompanyBlockToolInterceptor,
  JobQuery,
  JobList,
  StampToolInterceptor,
} from "./components.fixture.js";

const workflowsOf = async (application: object): Promise<readonly AssembledWorkflow[]> =>
  (await applicationOf(application as never)).workflows;

const named = (workflows: readonly AssembledWorkflow[], name: string): AssembledWorkflow => {
  const found = workflows.find((workflow) => workflow.config.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

const chainsOf = (workflow: AssembledWorkflow, agent: string): Record<string, string[]> =>
  Object.fromEntries(
    [...(workflow.toolInterceptors?.byAgent.get(agent) ?? [])].map(([tool, chain]) => [
      tool,
      chain.map((interceptor) => interceptor.name),
    ]),
  );

describe("#384: the levels add up, outer first; excludes remove", () => {
  it("application → workflow → agent → tool, each agent's and tool's excludes applied", async () => {
    const workflows = await workflowsOf(ScoutApplication);

    expect(chainsOf(named(workflows, "scout-workflow"), "scout-agent")).toEqual({
      "job-search-tool": [
        "audit-tool-interceptor",
        "tenant-scope-tool-interceptor",
        "moody-tool-interceptor",
        "stamp-tool-interceptor",
      ],
      "company-tool": [
        "tenant-scope-tool-interceptor",
        "moody-tool-interceptor",
        "company-block-tool-interceptor",
      ],
      "board-lookup-tool": [
        "audit-tool-interceptor",
        "tenant-scope-tool-interceptor",
        "moody-tool-interceptor",
        "company-block-tool-interceptor",
      ],
      "ping-tool": [
        "audit-tool-interceptor",
        "tenant-scope-tool-interceptor",
        "moody-tool-interceptor",
      ],
    });
    expect(chainsOf(named(workflows, "quiet-workflow"), "quiet-agent")).toEqual({
      "job-search-tool": ["stamp-tool-interceptor"],
      "company-tool": ["company-block-tool-interceptor"],
    });
  });
});

/** A one-agent application around `agent`, with the application's and the workflow's lists. */
function appWith(agentClass: object, lists: { app?: object[]; workflow?: object[] } = {}): object {
  @Workflow({
    name: "bad-workflow",
    version: "1.0.0",
    flow: [
      start(ScoutStart)
        .returns(WorkflowStartTextDto)
        .toAgent(agentClass as never)
        .toFinish(ScoutAnswer),
    ],
    toolInterceptors: (lists.workflow ?? []) as never,
  })
  class BadWorkflow {}

  @Application({
    name: "bad-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [BadWorkflow],
    toolInterceptors: (lists.app ?? []) as never,
    budgets: TEST_BUDGETS,
  })
  class BadApplication {}
  return BadApplication;
}

async function codesOf(application: object): Promise<string[]> {
  const error: unknown = await applicationOf(application as never).catch(
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError)) throw new Error("expected a GraphRuleError");
  return error.violations.map((item) => item.code);
}

// @ts-expect-error -- a tool interceptor implements BeforeToolCall, AfterToolCall or both
@ToolInterceptor({ name: "idle-tool-interceptor", description: "Does nothing" })
class IdleToolInterceptor {}

@ToolInterceptor({ name: "badly-named", description: "Its name lacks the suffix" })
class BadlyNamedInterceptor {
  beforeToolCall(): ToolCallDecision {
    return ToolCallDecision.allow();
  }
}

class NotAnInterceptor {
  beforeToolCall(): ToolCallDecision {
    return ToolCallDecision.allow();
  }
}

@Tool({
  name: "excluding-tool",
  description: "Excludes what nothing lists",
  input: JobQuery,
  output: JobList,
  excludeToolInterceptors: [StampToolInterceptor],
})
class ExcludingTool implements ToolHandler<JobQuery, JobList> {
  run(): Promise<JobList> {
    return Promise.resolve({ listing: "" });
  }
}

describe("#384: the assembly rules", () => {
  it("[tool-interceptor.missing-handler] and [name.kind-suffix]", async () => {
    @Agent({
      name: "bad-agent",
      description: "a",
      prompt: "a",
      model: "test/a",
      toolInterceptors: [IdleToolInterceptor, BadlyNamedInterceptor],
    })
    class BadAgent {}

    expect(await codesOf(appWith(BadAgent))).toEqual([
      "tool-interceptor.missing-handler",
      "name.kind-suffix",
    ]);
  });

  it("[tool-interceptor.not-an-interceptor] on every level that lists one", async () => {
    @Agent({
      name: "bad-agent",
      description: "a",
      prompt: "a",
      model: "test/a",
      toolInterceptors: [NotAnInterceptor],
    })
    class BadAgent {}

    const codes = await codesOf(appWith(BadAgent, { app: [NotAnInterceptor] }));

    expect(codes).toEqual([
      "tool-interceptor.not-an-interceptor",
      "tool-interceptor.not-an-interceptor",
    ]);
  });

  it("[tool-interceptor.exclude-not-inherited] on an agent and on a tool", async () => {
    @Agent({
      name: "bad-agent",
      description: "a",
      prompt: "a",
      model: "test/a",
      tools: [ExcludingTool],
      // the workflow lists it, not the application: still inherited
      excludeToolInterceptors: [AuditToolInterceptor, CompanyBlockToolInterceptor],
    })
    class BadAgent {}

    const codes = await codesOf(appWith(BadAgent, { workflow: [AuditToolInterceptor] }));

    expect(codes).toEqual([
      "tool-interceptor.exclude-not-inherited",
      "tool-interceptor.exclude-not-inherited",
    ]);
  });
});

describe("#384: describe and configHash", () => {
  it("describe prints each interceptor's methods and the agents' tools it intercepts", async () => {
    const lines = describeWorkflow(named(await workflowsOf(ScoutApplication), "scout-workflow"));

    expect(lines).toContain("tool interceptors");
    expect(lines).toContainEqual(
      "  audit-tool-interceptor — before, after · on scout-agent: job-search-tool, board-lookup-tool, ping-tool",
    );
    expect(lines).toContainEqual(
      "  stamp-tool-interceptor — after · on scout-agent: job-search-tool",
    );
    const shop = (await workflowsOf(ShopApplication))[0];
    expect(shop === undefined ? [] : describeWorkflow(shop)).toContain("tool interceptors none");
  });

  it("describe --json gives an agent its chains by tool, only when it has one", async () => {
    const scout = named(await workflowsOf(ScoutApplication), "scout-workflow");
    const agent = nodesOf(scout).find((node) => node.name === "scout-agent")?.agent;

    expect(agent?.toolInterceptors?.["ping-tool"]).toEqual([
      "audit-tool-interceptor",
      "tenant-scope-tool-interceptor",
      "moody-tool-interceptor",
    ]);
    const shop = (await workflowsOf(ShopApplication))[0];
    const sales =
      shop === undefined ? undefined : nodesOf(shop).find((n) => n.name === "sales-agent");
    expect(sales?.agent).not.toHaveProperty("toolInterceptors");
  });

  it("configHash covers the interceptors and the chains; a workflow without one keeps its shape", async () => {
    const scout = named(await workflowsOf(ScoutApplication), "scout-workflow");
    const snapshot = configSnapshot(scout) as {
      readonly toolInterceptors: {
        readonly interceptors: readonly object[];
        readonly chains: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
      };
    };

    expect(snapshot.toolInterceptors.interceptors).toContainEqual({
      name: "stamp-tool-interceptor",
      before: false,
      after: true,
    });
    expect(snapshot.toolInterceptors.chains["scout-agent"]?.["company-tool"]).toEqual([
      "tenant-scope-tool-interceptor",
      "moody-tool-interceptor",
      "company-block-tool-interceptor",
    ]);
    const shop = (await workflowsOf(ShopApplication))[0];
    expect(shop === undefined ? {} : configSnapshot(shop)).not.toHaveProperty("toolInterceptors");
  });
});
