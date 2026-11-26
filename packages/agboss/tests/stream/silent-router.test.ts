/** #1004 AC1: a chat-model router's raw JSON decision never reaches the user's stream. */
import { describe, expect, it } from "vitest";
import {
  Agent,
  DecidedBy,
  Router,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  inline,
  Ttl,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { ChatStart, Reply } from "../channels/approval.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, onStart, toAgent, toFinish } from "../helpers/flow.js";
import {
  answer,
  BedrockModelProvider,
  BedrockSdkClient,
  ScriptedBedrockClient,
} from "../models/transport/bedrock-provider.fixture.js";
import { transportApp } from "../models/transport/transport-app.js";
import { deltas } from "./writer.fixture.js";

@Agent({
  name: "routed-audit-agent",
  description: "Answers",
  prompt: inline("Answer."),
  model: "bedrock/claude",
})
class RoutedAgent {}

@WorkflowFinish({
  name: "audit-hand-over-workflow-finish",
  description: "Handed over",
  output: WorkflowStartTextDto,
})
class HandOver {}

@Router({
  name: "audit-chat-router",
  description: "Picks the agent",
  decidedBy: DecidedBy.Model,
  prompt: inline("INTERNAL ROUTING PROMPT"),
  model: "bedrock/claude",
  input: { message: WorkflowStartTextDto },
  routes: [
    { prompt: "Everything", target: RoutedAgent },
    { prompt: "Stop and hand over", target: HandOver },
  ],
})
class AuditChatRouter {}

@Workflow({
  name: "routed-audit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ChatStart)
      .toRouter(AuditChatRouter)
      .onRoute(toAgent(RoutedAgent).toFinish(Reply))
      .onRoute(toFinish(HandOver)),
  ],
  defaults: { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } },
})
class RoutedWorkflow {}

@Application({
  name: "routed-audit-application",
  modelProvider: BedrockModelProvider,
  version: "1.0.0",
  workflows: [RoutedWorkflow],
  providers: [BedrockModelProvider, BedrockSdkClient],
  budgets: TEST_BUDGETS,
})
class RoutedApplication {}

describe("#1004: the chat-model router is silent", () => {
  it("AC1: the router's decision JSON is not a delta; the agent's answer is", async () => {
    const client = new ScriptedBedrockClient([
      answer('{"next":"routed-audit-agent","reason":"INTERNAL ROUTER REASONING"}'),
      answer("The user-facing answer."),
    ]);
    const app = await transportApp(RoutedApplication, { client });
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ChatStart,
      { text: "hello" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: "The user-facing answer." });
    expect(client.invocations).toHaveLength(2);
    expect(deltas(events)).toEqual(["The user-facing answer."]);
    await app.close();
  });
});
