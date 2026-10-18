import { describe, expect, it } from "vitest";
import {
  Agent,
  Guardrail,
  Injectable,
  PiiPolicy,
  Tool,
  Workflow,
  Action,
  type AppState,
  type OnActionEnd,
  type OnActionStart,
  type OnAgentEnd,
  type OnAgentStart,
  type OnChannelEnd,
  type OnChannelStart,
  type OnGuardrailEnd,
  type OnGuardrailStart,
  type OnPiiPolicyEnd,
  type OnPiiPolicyStart,
  type OnToolEnd,
  type OnToolStart,
  type OnWorkflowEnd,
  type OnWorkflowStart,
  type ActionEndEvent,
  type ActionStartEvent,
  type AgentEndEvent,
  type AgentStartEvent,
  type ChannelEndEvent,
  type ChannelStartEvent,
  type GuardrailEndEvent,
  type GuardrailStartEvent,
  type PiiPolicyEndEvent,
  type PiiPolicyStartEvent,
  type ToolEndEvent,
  type ToolStartEvent,
  WorkflowStart,
  WorkflowFinish,
} from "../../src/index.js";
import { WorkflowStartTextDto, WorkflowFinishTextDto, Text } from "../../src/dto/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { replyWith, callTool } from "../../src/testing/index.js";
import { testDefaults } from "../helpers.js";
import { execute, start } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

class ToolInput {
  @Text() text!: string;
}

const hookEvents: string[] = [];

@Injectable()
class TailsObserver
  implements
    OnWorkflowStart,
    OnWorkflowEnd,
    OnAgentStart,
    OnAgentEnd,
    OnActionStart,
    OnActionEnd,
    OnToolStart,
    OnToolEnd,
    OnGuardrailStart,
    OnGuardrailEnd,
    OnPiiPolicyStart,
    OnPiiPolicyEnd,
    OnChannelStart,
    OnChannelEnd
{
  async onWorkflowStart() {
    hookEvents.push("WorkflowStart");
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

  async onToolStart(ctx: ToolStartEvent) {
    hookEvents.push(`ToolStart:${ctx.toolName}`);
  }
  async onToolEnd(ctx: ToolEndEvent) {
    hookEvents.push(`ToolEnd:${ctx.toolName}`);
  }

  async onActionStart(ctx: ActionStartEvent) {
    hookEvents.push(`ActionStart:${ctx.name}`);
  }
  async onActionEnd(ctx: ActionEndEvent) {
    hookEvents.push(`ActionEnd:${ctx.name}`);
  }

  async onGuardrailStart(ctx: GuardrailStartEvent) {
    hookEvents.push(`GuardrailStart:${ctx.name}`);
  }
  async onGuardrailEnd(ctx: GuardrailEndEvent) {
    hookEvents.push(`GuardrailEnd:${ctx.name}`);
  }

  async onPiiPolicyStart(ctx: PiiPolicyStartEvent) {
    hookEvents.push(`PiiStart:${ctx.name}`);
  }
  async onPiiPolicyEnd(ctx: PiiPolicyEndEvent) {
    hookEvents.push(`PiiEnd:${ctx.name}`);
  }

  async onChannelStart(ctx: ChannelStartEvent) {
    hookEvents.push(`ChannelStart:${ctx.name}`);
  }
  async onChannelEnd(ctx: ChannelEndEvent) {
    hookEvents.push(`ChannelEnd:${ctx.name}`);
  }
}

@PiiPolicy({ name: "MaskingPolicy" })
class MaskingPolicy {
  async maskJson(obj: any) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return obj;
  }
  async mask(text: string) {
    return text;
  }
  async unmask(text: string) {
    return text;
  }
}

@Guardrail({ name: "SafeGuard" })
class SafeGuard {
  async beforeToolCall() {
    /* noop */
  }
  async afterToolCall() {
    /* noop */
  }
}

@Tool({
  name: "SafeTool",
  description: "Does things",
  input: ToolInput,
  output: ToolInput,
})
class SafeTool {
  async run() {
    return { text: "done" };
  }
}

@Agent({
  name: "safe-agent",
  description: "test agent",
  model: "test",
  tools: [SafeTool],

  guardrails: [SafeGuard],
})
class SafeAgent {}

@Action({ name: "format-action", description: "Formats" })
class FormatAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@WorkflowStart({ name: "start-workflow-start", input: WorkflowStartTextDto, description: "" })
class StartNode {}

@WorkflowFinish({ name: "finish-workflow-finish", output: WorkflowFinishTextDto, description: "" })
class FinishNode {}

@Workflow({
  name: "tails-test-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  observers: [TailsObserver],
  flow: [
    start(StartNode)
      .returns(WorkflowStartTextDto)
      .toAction(FormatAction)
      .toAgent(SafeAgent)
      .toFinish(FinishNode),
  ],
})
class TailsWorkflow {}

@Application({
  name: "tails-test-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TailsWorkflow],
  budgets: TEST_BUDGETS,
})
class TailsApplication {}

describe("Observability Tails Hooks", () => {
  it("fires tails hooks in precise order", async () => {
    hookEvents.length = 0;

    const book = new ScriptBook();
    book
      .scriptOf("agent:safe-agent")
      .thenReturn(callTool(SafeTool, { text: "hello" }), replyWith("Hello user!"));

    const { app } = await buildApplication(await applicationOf(TailsApplication), {
      gateway: createScriptedGateway(book),
    });

    await execute(app, StartNode, { text: "hi" });

    // Assert the exact flow
    // Workflow -> Action -> Agent -> Pii -> Guardrail -> Tool -> Guardrail -> Pii -> Agent -> WorkflowEnd

    // Check Action
    expect(hookEvents).toContain("ActionStart:format-action");
    expect(hookEvents).toContain("ActionEnd:format-action");

    // Order assertions
    const agentStart = hookEvents.indexOf("AgentStart:safe-agent");
    const piiStart = hookEvents.indexOf("PiiStart:MaskingPolicy");
    const guardrailStart = hookEvents.indexOf("GuardrailStart:SafeGuard");
    const toolStart = hookEvents.indexOf("ToolStart:SafeTool");
    const toolEnd = hookEvents.indexOf("ToolEnd:SafeTool");
    const guardrailEnd = hookEvents.indexOf("GuardrailEnd:SafeGuard");

    const agentEnd = hookEvents.indexOf("AgentEnd:safe-agent");
    expect(agentStart).toBeLessThan(guardrailStart);

    expect(guardrailStart).toBeLessThan(toolStart);
    expect(toolStart).toBeLessThan(toolEnd);
    const guardrailEnd2 = hookEvents.lastIndexOf("GuardrailEnd:SafeGuard");
    expect(toolEnd).toBeLessThan(guardrailEnd2);
    expect(guardrailEnd2).toBeLessThan(agentEnd);

    await app.close();
  });
});
