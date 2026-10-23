import {
  Agent,
  EmptyEnvironment,
  Injectable,
  Judge,
  JudgeVerdict,
  Tool,
  ToolCallStatus,
  toolCallsOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type JudgeHandler,
  type JudgeInput,
  type ToolCallRecord,
  type ToolHandler,
} from "../../../src/index.js";
import {
  PlainTextDto,
  Text,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { PiiPolicy } from "../../../src/pii/pii-policy.decorator.js";
import { PiiAction, PiiKind, pii } from "../../../src/pii/index.js";
import { start } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { PromptInjectionGuardrail } from "../../fixtures/guardrails.js";

/**
 * #395 — tool-call trajectories: a clerk that looks orders up (a tool that fails for "lost"), a
 * judge that passes a reply only after a successful lookup and keeps what it saw, an input guardrail,
 * a PII policy that masks e-mail addresses in the record, and a parent that runs the clerk's
 * workflow as its child.
 */

export class OrderLookup {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class OrderFound {
  @Text()
  status!: string;
}

@Tool({
  name: "lookup-order-tool",
  description: "Looks an order up",
  input: OrderLookup,
  output: OrderFound,
})
export class LookupOrderTool implements ToolHandler<OrderLookup, OrderFound> {
  run({ orderId }: OrderLookup): Promise<OrderFound> {
    if (orderId === "lost") return Promise.reject(new Error("no such order"));
    return Promise.resolve({ status: `order ${orderId} shipped` });
  }
}

/** What the judge saw on each call: the test reads it through `mockOf`. */
@Injectable()
export class TrajectoryLog {
  seen(toolCalls: readonly ToolCallRecord[]): readonly ToolCallRecord[] {
    return toolCalls;
  }
}

/** Passes a reply only when a lookup of this visit succeeded (#395 example). */
@Judge({
  name: "looked-up-judge",
  model: "local/judge",
  reply: PlainTextDto,
  deps: [TrajectoryLog],
})
export class LookedUpJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly trajectoryLog: TrajectoryLog) {}

  judge({ toolCalls }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    this.trajectoryLog.seen(toolCalls);
    const calls = toolCallsOf(LookupOrderTool, toolCalls);
    const lookups = calls.filter((call) => call.status === ToolCallStatus.Succeeded);
    return Promise.resolve(
      lookups.length > 0
        ? JudgeVerdict.passed({ metrics: { lookups: lookups.length } })
        : JudgeVerdict.failed({ reason: "Look the order up first." }),
    );
  }
}

@Agent({
  name: "clerk-agent",
  prompt: "Answer questions about orders.",
  description: "Looks orders up",
  model: "local/llama",
  tools: [LookupOrderTool],
  judges: [LookedUpJudge],
  maxRetries: 1,
  guardrails: [PromptInjectionGuardrail],
})
export class ClerkAgent {}

@WorkflowStart({
  name: "clerk-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
export class ClerkStart {}

@WorkflowFinish({
  name: "clerk-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class ClerkFinish {}

const DEFAULTS = {
  models: { temperature: 0 },
  router: { model: "typesafe/jev-1.13" },
  guardrail: { model: "typesafe/jev-1.13" },
} as const;

@Workflow({
  name: "clerk-workflow",
  version: "1.0.0",
  flow: [
    start(ClerkStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ClerkAgent)
      .toFinish(ClerkFinish),
  ],
  defaults: DEFAULTS,
  providers: [TrajectoryLog],
})
export class ClerkWorkflow {}

@WorkflowStart({
  name: "front-desk-workflow-start",
  description: "A question for the front desk",
  input: WorkflowStartTextDto,
})
export class FrontDeskStart {}

@WorkflowFinish({
  name: "front-desk-workflow-finish",
  description: "The clerk's answer",
  output: WorkflowFinishTextDto,
})
export class FrontDeskFinish {}

/** The parent: the clerk's workflow as its one child. */
@Workflow({
  name: "front-desk-workflow",
  version: "1.0.0",
  flow: [
    start(FrontDeskStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(ClerkWorkflow)
      .returns(WorkflowFinishTextDto)
      .toFinish(FrontDeskFinish),
  ],
  defaults: DEFAULTS,
})
export class FrontDeskWorkflow {}

@PiiPolicy({
  name: "order-pii-policy",
  description: "Hides e-mail addresses",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
export class OrderPiiPolicy {}

@Application({
  name: "trajectory-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClerkWorkflow, FrontDeskWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
  piiPolicies: [OrderPiiPolicy],
})
export class TrajectoryApplication {}
