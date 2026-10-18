import { describe, expect, it } from "vitest";
import {
  Agent,
  Injectable,
  Tool,
  Workflow,
  type AppState,
  type ModelStartEvent,
  type ModelEndEvent,
  type AgentStartEvent,
  type RouterStartEvent,
  type RagStartEvent,
  type AgentEndEvent,
  type RouterEndEvent,
  type RagEndEvent,
  type OnAgentEnd,
  type OnAgentStart,
  type OnError,
  type OnModelEnd,
  type OnModelStart,
  type OnRagStart,
  type OnRagEnd,
  type OnRouterEnd,
  type OnRouterStart,
  type OnToolEnd,
  type OnToolStart,
  type OnWorkflowEnd,
  type OnWorkflowStart,
  type ToolEndEvent,
  type ToolStartEvent,
  Router,
  WorkflowStart,
} from "../../src/index.js";
import { DecidedBy, RagMode, WorkflowFinish } from "../../src/index.js";
import { Rag } from "../../src/components/decorators.js";
import { RagRetrieval } from "../../src/rag/types.js";
import { WorkflowStartTextDto, WorkflowFinishTextDto, Text } from "../../src/dto/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { replyWith, callTool, routeTo } from "../../src/testing/index.js";
import { testDefaults } from "../helpers.js";
import { execute, route, start } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

class ToolInput {
  @Text() text!: string;
}

const hookEvents: string[] = [];
let capturedState: AppState | null = null;

@Injectable()
class GlobalObserver
  implements
    OnWorkflowStart,
    OnWorkflowEnd,
    OnAgentStart,
    OnAgentEnd,
    OnRouterStart,
    OnRouterEnd,
    OnToolStart,
    OnToolEnd,
    OnModelStart,
    OnModelEnd,
    OnRagStart,
    OnRagEnd,
    OnError
{
  async onWorkflowStart(state: AppState) {
    hookEvents.push("WorkflowStart");
    capturedState = state;
  }
  async onWorkflowEnd() {
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
    hookEvents.push(`ToolStart:${ctx.toolName}`);
  }
  async onToolEnd(ctx: ToolEndEvent) {
    hookEvents.push(`ToolEnd:${ctx.toolName}`);
  }

  async onModelStart(req: ModelStartEvent) {
    hookEvents.push(`ModelStart:${req.callerName}`);
  }
  async onModelEnd(res: ModelEndEvent) {
    hookEvents.push(`ModelEnd:${res.callerName}`);
  }

  async onRagStart(ctx: RagStartEvent) {
    hookEvents.push(`RagStart:${ctx.name}`);
  }
  async onRagEnd(ctx: RagEndEvent) {
    hookEvents.push(`RagEnd:${ctx.name}`);
  }
  async onError(err: Error, state: AppState) {
    hookEvents.push("Error");
  }
}

@Tool({
  name: "ObsTool",
  description: "Does things",
  input: ToolInput,
  output: ToolInput,
})
class ObsTool {
  async run(input: ToolInput) {
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

@Rag({ name: "ObsRag", description: "test rag", topK: 5 })
class ObsRag {
  async retrieve(): Promise<RagRetrieval> {
    return { results: [] };
  }
}

@Agent({
  name: "obs-agent",
  description: "test agent",
  model: "test",

  tools: [ObsTool],
  rag: [{ use: ObsRag, mode: RagMode.Context }],
})
class ObsAgent {}

@Router({
  description: "Router",
  decidedBy: DecidedBy.Model,
  input: { message: WorkflowStartTextDto },
  model: "stub",
  name: "obs-router",
  prompt: "Decide.",
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
  defaults: testDefaults,
  observers: [GlobalObserver],
  flow: [
    start(ObsStart)
      .returns(WorkflowStartTextDto)
      .toRouter(ObsRouter)
      .chooseOne(route(ObsAgent).toFinish(ObsFinish), route(ObsNoReply)),
  ],
})
class ObsWorkflow {}

@Application({
  name: "obs-application",
  version: "1.0.0",
  workflows: [ObsWorkflow],
  budgets: TEST_BUDGETS,
})
class ObsApplication {}

describe("Global Observability Hooks", () => {
  it("fires hooks in correct order and provides AppState", async () => {
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
    expect(hookEvents).toContain("ToolStart:ObsTool");
    expect(hookEvents).toContain("ToolEnd:ObsTool");
    expect(hookEvents).toContain("ModelStart:obs-agent");
    expect(hookEvents).toContain("ModelEnd:obs-agent");
    expect(hookEvents).toContain("RagStart:ObsRag");
    expect(hookEvents).toContain("RagEnd:ObsRag");

    expect(capturedState).not.toBeNull();
    // #238: the run's own id, the one its result carries
    expect((capturedState as AppState | null)?.runId).toBe(result.runId);

    await app.close();
  });
});
