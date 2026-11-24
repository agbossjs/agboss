import { RagScope } from "../../src/rag/types.js";
import { RagSource } from "../../src/rag/rag-source.js";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Observer,
  Tool,
  Workflow,
  type ExecutionStartEvent,
  type ModelStartEvent,
  type ModelEndEvent,
  type AgentStartEvent,
  type RouterStartEvent,
  type RagStartEvent,
  type AgentEndEvent,
  type RouterEndEvent,
  type RagEndEvent,
  type ToolEndEvent,
  type ToolStartEvent,
  Router,
  WorkflowStart,
  inline,
  Ttl,
} from "../../src/index.js";
import { DecidedBy, WorkflowFinish } from "../../src/index.js";
import { Rag } from "../../src/components/decorators.js";
import { RagRetrieval } from "../../src/rag/types.js";
import { WorkflowStartTextDto, WorkflowFinishTextDto, Text } from "../../src/dto/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { replyWith, callTool, routeTo } from "../../src/testing/index.js";
import { testDefaults } from "../helpers.js";
import { execute, onStart, toAgent, toFinish } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

class ToolInput {
  @Text() text!: string;
}

const hookEvents: string[] = [];
let capturedState: ExecutionStartEvent | null = null;

@Observer()
class GlobalObserver {
  async onExecutionStart(state: ExecutionStartEvent) {
    hookEvents.push("WorkflowStart");
    capturedState = state;
  }
  async onExecutionEnd() {
    hookEvents.push("WorkflowEnd");
  }

  async onAgentStart(ctx: AgentStartEvent) {
    hookEvents.push(`AgentStart:${ctx.name}`);
  }
  async onAgentEnd(ctx: AgentEndEvent) {
    hookEvents.push(`AgentEnd:${ctx.name}`);
  }

  async onRouterStart(ctx: RouterStartEvent) {
    hookEvents.push(`RouterStart:${ctx.name}`);
  }
  async onRouterEnd(ctx: RouterEndEvent) {
    hookEvents.push(`RouterEnd:${ctx.name}`);
  }

  async onToolStart(ctx: ToolStartEvent) {
    hookEvents.push(`ToolStart:${ctx.tool}`);
  }
  async onToolEnd(ctx: ToolEndEvent) {
    hookEvents.push(`ToolEnd:${ctx.tool}`);
  }

  async onModelStart(req: ModelStartEvent) {
    hookEvents.push(`ModelStart:${req.caller}`);
  }
  async onModelEnd(res: ModelEndEvent) {
    hookEvents.push(`ModelEnd:${res.caller}`);
  }

  async onRagStart(ctx: RagStartEvent) {
    hookEvents.push(`RagStart:${ctx.name}`);
  }
  async onRagEnd(ctx: RagEndEvent) {
    hookEvents.push(`RagEnd:${ctx.name}`);
  }
  async onExecutionError() {
    hookEvents.push("Error");
  }
}

@Tool({
  name: "obs-tool",
  description: "Does things",
  input: ToolInput,
  output: ToolInput,
})
class ObsTool {
  async execute(input: ToolInput) {
    return { text: "done" };
  }
}

@WorkflowStart({ name: "start-workflow-start", description: "Start", input: WorkflowStartTextDto })
class ObsStart {}

@WorkflowFinish({
  name: "obs-workflow-finish",
  description: "Finish",
  output: WorkflowFinishTextDto,
})
class ObsFinish {}

@WorkflowFinish({
  name: "obs-no-reply-workflow-finish",
  description: "No reply",
  output: WorkflowStartTextDto,
})
class ObsNoReply {}

@Rag({ name: "ObsRag", description: "test rag", scope: RagScope.Tenant, topK: 5 })
class ObsRag extends RagSource {
  protected override async retrieve(): Promise<RagRetrieval> {
    return { results: [] };
  }
}

@Agent({
  name: "obs-agent",
  description: "test agent",
  model: "test",

  tools: [ObsTool],
  rag: [ObsRag],
})
class ObsAgent {}

@Router({
  description: "Router",
  decidedBy: DecidedBy.Model,
  input: { message: WorkflowStartTextDto },
  model: "stub",
  name: "obs-router",
  prompt: inline("Decide."),
  maxVisits: 10,
  routes: [
    { prompt: "go", target: ObsAgent },
    { prompt: "stop", target: ObsNoReply },
  ],
})
class ObsRouter {}

@Workflow({
  name: "obs-test-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: testDefaults,
  flow: [
    onStart(ObsStart)
      .toRouter(ObsRouter)
      .onRoute(toAgent(ObsAgent).toFinish(ObsFinish))
      .onRoute(toFinish(ObsNoReply)),
  ],
})
class ObsWorkflow {}

@Application({
  name: "obs-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ObsWorkflow],
  observers: [GlobalObserver],
  budgets: TEST_BUDGETS,
})
class ObsApplication {}

describe("Global Observability Hooks", () => {
  it("fires hooks in correct order and gives the execution event", async () => {
    hookEvents.length = 0; // reset
    capturedState = null;

    const book = new ScriptBook();
    book.scriptOf("router:obs-router").thenReturn(routeTo(ObsAgent));
    book
      .scriptOf("agent:obs-agent")
      .thenReturn(callTool(ObsTool, { text: "hello" }), replyWith("Hello user!"));

    const { app } = await buildApplication(await applicationOf(ObsApplication), {
      gateway: createScriptedGateway(book),
    });

    book.scriptOf("router:obs-router").thenReturn(routeTo(ObsAgent));
    book
      .scriptOf("agent:obs-agent")
      .thenReturn(callTool(ObsTool, { text: "hello" }), replyWith("Hello user!"));
    const result = await execute(app, ObsStart, { text: "Hi" });

    // Ensure all hook types fired
    expect(hookEvents).toContain("WorkflowStart");
    expect(hookEvents).toContain("WorkflowEnd");
    expect(hookEvents).toContain("RouterStart:obs-router");
    expect(hookEvents).toContain("RouterEnd:obs-router");
    expect(hookEvents).toContain("AgentStart:obs-agent");
    expect(hookEvents).toContain("AgentEnd:obs-agent");
    expect(hookEvents).toContain("ToolStart:obs-tool");
    expect(hookEvents).toContain("ToolEnd:obs-tool");
    expect(hookEvents).toContain("ModelStart:obs-agent");
    expect(hookEvents).toContain("ModelEnd:obs-agent");
    expect(hookEvents).toContain("RagStart:ObsRag");
    expect(hookEvents).toContain("RagEnd:ObsRag");

    expect(capturedState).not.toBeNull();
    // #238: the run's own id, the one its result carries
    expect((capturedState as ExecutionStartEvent | null)?.executionId).toBe(result.executionId);

    await app.close();
  });
});
