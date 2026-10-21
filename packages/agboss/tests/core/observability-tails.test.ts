import { describe, expect, it } from "vitest";
import {
  Agent,
  InputGuardrail,
  Injectable,
  OutputGuardrail,
  Tool,
  Workflow,
  Action,
  type OnActionEnd,
  type OnActionStart,
  type OnAgentEnd,
  type OnAgentStart,
  type OnChannelEnd,
  type OnChannelStart,
  type OnGuardrailEnd,
  type OnGuardrailStart,
  type OnToolEnd,
  type OnToolStart,
  type OnExecutionEnd,
  type OnExecutionStart,
  type ActionEndEvent,
  type ActionStartEvent,
  type AgentEndEvent,
  type AgentStartEvent,
  type ChannelEndEvent,
  type ChannelStartEvent,
  type GuardrailEndEvent,
  type GuardrailStartEvent,
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
    OnExecutionStart,
    OnExecutionEnd,
    OnAgentStart,
    OnAgentEnd,
    OnActionStart,
    OnActionEnd,
    OnToolStart,
    OnToolEnd,
    OnGuardrailStart,
    OnGuardrailEnd,
    OnChannelStart,
    OnChannelEnd
{
  async onExecutionStart() {
    hookEvents.push("WorkflowStart");
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

  async onChannelStart(ctx: ChannelStartEvent) {
    hookEvents.push(`ChannelStart:${ctx.name}`);
  }
  async onChannelEnd(ctx: ChannelEndEvent) {
    hookEvents.push(`ChannelEnd:${ctx.name}`);
  }
}

@InputGuardrail({
  name: "safe-input-guardrail",
  description: "Checks what the agent reads",
  prompt: "Is the message unsafe?",
  model: "typesafe/jev-1.13",
  threshold: 0.9,
  refusal: "No.",
})
class SafeInputGuardrail {}

@OutputGuardrail({
  name: "safe-output-guardrail",
  description: "Checks what the agent answers",
  prompt: "Is the answer unsafe?",
  model: "typesafe/jev-1.13",
  threshold: 0.9,
  refusal: "No.",
})
class SafeOutputGuardrail {}

@Tool({
  name: "safe-tool",
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
  guardrails: [SafeInputGuardrail, SafeOutputGuardrail],
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
  observers: [TailsObserver],
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

    // Workflow -> Action -> Agent -> input guardrail -> Tool -> output guardrail -> Agent end

    // Check Action
    expect(hookEvents).toContain("ActionStart:format-action");
    expect(hookEvents).toContain("ActionEnd:format-action");

    // Order assertions
    const agentEvents = hookEvents.filter((event) => /^(Agent|Guardrail|Tool)/.test(event));
    expect(agentEvents).toEqual([
      "AgentStart:safe-agent",
      "GuardrailStart:safe-input-guardrail",
      "GuardrailEnd:safe-input-guardrail",
      "ToolStart:safe-tool",
      "ToolEnd:safe-tool",
      "GuardrailStart:safe-output-guardrail",
      "GuardrailEnd:safe-output-guardrail",
      "AgentEnd:safe-agent",
    ]);

    await app.close();
  });
});
