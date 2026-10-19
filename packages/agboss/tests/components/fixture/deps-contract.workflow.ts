import {
  Agent,
  provide,
  RagMode,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type WorkflowOptions,
} from "../../../src/index.js";
import type { Class } from "../../../src/components/injection.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Reasoning } from "../../../src/models/index.js";
import { start } from "../../helpers/flow.js";
import type { AppOptions } from "../../../src/app/create-app.js";
import { createSqliteTernStore } from "../../../src/terns/index.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import {
  AuditGuardrail,
  KeptDto,
  MaskSecret,
  RemoteAgent,
  RevealTool,
  SECRET,
  StampAction,
  StrictJudge,
  Vault,
  VaultDocs,
} from "./deps-contract.components.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** Scripted models and in-memory stores: nothing external. */
export const offline = (book = new ScriptBook()): AppOptions => ({
  processEnv: {},
  gateway: createScriptedGateway(book),
});

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class Chat {}

@WorkflowFinish({
  name: "reply-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class Done {}

/** What the keeper kept. */
export { KeptDto } from "./deps-contract.components.js";

@WorkflowFinish({ name: "kept-workflow-finish", description: "What was kept", output: KeptDto })
export class Kept {}

const price = { inputPerMTok: 1, outputPerMTok: 10 };

@Agent({
  name: "keeper-agent",
  description: "Keeps the vault",
  model: "test/keeper",
  price,
  tools: [RevealTool],
  guardrails: [AuditGuardrail],
  judges: [StrictJudge],
  rag: [{ use: VaultDocs, mode: RagMode.Context }],
  input: { message: WorkflowStartTextDto },
  output: KeptDto,
})
export class Keeper {}

@Agent({ name: "plain-agent", description: "Plain", model: "test/plain", price })
export class Plain {}

const base = {
  version: "1.0.0",
  defaults: {
    models: { temperature: 0, reasoning: Reasoning.modelDecides(), cache: true },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
    history: { limit: 2 },
  },
} satisfies Partial<WorkflowOptions>;

/** A workflow `Chat → text agent → Done` with extra settings, for the assembly checks. */
export function workflowWith(
  name: string,
  extra: Partial<WorkflowOptions>,
  agent: Class = Plain,
): Class {
  @Workflow({
    name,
    flow: [
      start(Chat)
        .returns(WorkflowStartTextDto)
        .toAgent(agent)
        .toFinish(Done),
    ],
    ...base,
    ...extra,
  })
  class Built {}
  return Built;
}

/** The application of `workflowWith(…)`: what `createApp` assembles. */
export function applicationWith(
  name: string,
  extra: Partial<WorkflowOptions>,
  agent: Class = Plain,
): Class {
  const workflow = workflowWith(name, extra, agent);
  @Application({
    name: name.replace(/-workflow$/, "-application"),
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [workflow],
    budgets: TEST_BUDGETS,
  })
  class BuiltApplication {}
  return BuiltApplication;
}

/** Every kind that takes `deps`, all wired: tool, guardrail, judge, RAG, action, PII, channel, A2A. */
@Workflow({
  name: "vault-workflow",
  flow: [
    start(Chat)
      .returns(WorkflowStartTextDto)
      .toAgent(Keeper)
      .returns(KeptDto)
      .toAction(StampAction)
      .toFinish(Kept),
  ],
  ...base,
  piiPolicies: [MaskSecret],
  providers: [Vault, provide(SECRET, "s3cret"), RemoteAgent],
})
export class VaultWorkflow {}

@Application({
  name: "vault-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [VaultWorkflow],
  budgets: TEST_BUDGETS,
})
export class VaultApplication {}
