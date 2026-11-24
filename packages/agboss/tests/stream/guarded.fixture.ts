/**
 * Agents with a blocking output check, for the hold-back tests (#1006): one with an output
 * guardrail (code), a PII block rule for card numbers, a judge and a tool; one with the PII block
 * rule alone. Their text must never be on the wire before those checks passed.
 */
import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  GuardrailVerdict,
  OutputGuardrail,
  PiiKind,
  PiiPolicy,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type GuardrailContent,
  type GuardrailHandler,
  type PiiRefusal,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { FlowJudge } from "./agents.fixture.js";

@OutputGuardrail({
  name: "forbidden-word-guardrail",
  description: "Blocks answers with the forbidden word",
  decidedBy: DecidedBy.Code,
  refusal: "Refused.",
})
export class ForbiddenWordGuardrail implements GuardrailHandler {
  check({ text }: GuardrailContent): GuardrailVerdict {
    return text.includes("FORBIDDEN") ? GuardrailVerdict.blocked() : GuardrailVerdict.passed();
  }
}

@PiiPolicy({
  name: "audit-card-pii-policy",
  description: "Refuses card numbers",
  rules: [PiiKind.CardNumber.block()],
})
export class AuditCardPiiPolicy implements PiiRefusal {
  refusal(): string {
    return "No cards.";
  }
}

export class EchoQuery {
  @Text({ prompt: "what to echo" })
  text!: string;
}

@Tool({ name: "echo-tool", description: "Echoes", input: EchoQuery, output: EchoQuery })
export class EchoTool {
  execute(input: EchoQuery): Promise<EchoQuery> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "guarded-agent",
  prompt: "Write.",
  description: "Writes",
  model: "local/llama",
  guardrails: [ForbiddenWordGuardrail],
  piiPolicies: [AuditCardPiiPolicy],
  judges: [FlowJudge],
  maxRetries: 1,
  tools: [EchoTool],
})
export class GuardedAgent {}

@Agent({
  name: "card-only-agent",
  prompt: "Write.",
  description: "Writes",
  model: "local/llama",
  piiPolicies: [AuditCardPiiPolicy],
})
export class CardOnlyAgent {}

@Agent({
  name: "guardrail-only-agent",
  prompt: "Write.",
  description: "Writes",
  model: "local/llama",
  guardrails: [ForbiddenWordGuardrail],
})
export class GuardrailOnlyAgent {}

@WorkflowStart({
  name: "guarded-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class GuardedStart {}

@WorkflowFinish({
  name: "guarded-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class GuardedFinish {}

@Workflow({
  name: "guarded-workflow",
  version: "1.0.0",
  flow: [onStart(GuardedStart).toAgent(GuardedAgent).toFinish(GuardedFinish)],
  defaults: DEFAULTS,
})
class GuardedWorkflow {}

@WorkflowStart({ name: "card-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class CardStart {}

@WorkflowFinish({
  name: "card-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class CardFinish {}

@Workflow({
  name: "card-workflow",
  version: "1.0.0",
  flow: [onStart(CardStart).toAgent(CardOnlyAgent).toFinish(CardFinish)],
  defaults: DEFAULTS,
})
class CardWorkflow {}

@WorkflowStart({
  name: "guardrail-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class GuardrailStart {}

@WorkflowFinish({
  name: "guardrail-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class GuardrailFinish {}

@Workflow({
  name: "guardrail-workflow",
  version: "1.0.0",
  flow: [onStart(GuardrailStart).toAgent(GuardrailOnlyAgent).toFinish(GuardrailFinish)],
  defaults: DEFAULTS,
})
class GuardrailWorkflow {}

@Application({
  name: "guarded-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [GuardedWorkflow, CardWorkflow, GuardrailWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class GuardedApplication {}
