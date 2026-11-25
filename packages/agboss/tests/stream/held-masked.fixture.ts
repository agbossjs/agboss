/**
 * #1311b: a held agent (an output guardrail that passes) whose PII policy masks emails: its stream
 * must carry the masked answer, never the model's own tokens.
 */
import {
  Agent,
  EmptyEnvironment,
  GuardrailVerdict,
  OutputGuardrail,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type GuardrailHandler,
  inline,
  Ttl,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

@OutputGuardrail({
  name: "always-pass-guardrail",
  description: "Passes every answer",
  refusal: "Refused.",
})
export class AlwaysPassGuardrail implements GuardrailHandler {
  check(): GuardrailVerdict {
    return GuardrailVerdict.passed();
  }
}

@PiiPolicy({
  name: "email-mask-pii-policy",
  description: "Masks emails",
  rules: [PiiKind.Email.mask()],
})
export class EmailMaskPiiPolicy {}

@Agent({
  name: "masked-held-agent",
  prompt: inline("Write."),
  description: "Writes",
  model: "local/llama",
  guardrails: [AlwaysPassGuardrail],
  piiPolicies: [EmailMaskPiiPolicy],
})
export class MaskedHeldAgent {}

@Agent({
  name: "plain-held-agent",
  prompt: inline("Write."),
  description: "Writes",
  model: "local/llama",
  guardrails: [AlwaysPassGuardrail],
})
export class PlainHeldAgent {}

@WorkflowStart({
  name: "masked-held-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class MaskedHeldStart {}

@WorkflowFinish({
  name: "masked-held-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class MaskedHeldFinish {}

@Workflow({
  name: "masked-held-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(MaskedHeldStart).toAgent(MaskedHeldAgent).toFinish(MaskedHeldFinish)],
  defaults: DEFAULTS,
})
class MaskedHeldWorkflow {}

@WorkflowStart({
  name: "plain-held-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class PlainHeldStart {}

@WorkflowFinish({
  name: "plain-held-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class PlainHeldFinish {}

@Workflow({
  name: "plain-held-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(PlainHeldStart).toAgent(PlainHeldAgent).toFinish(PlainHeldFinish)],
  defaults: DEFAULTS,
})
class PlainHeldWorkflow {}

@Application({
  name: "masked-held-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MaskedHeldWorkflow, PlainHeldWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class MaskedHeldApplication {}
