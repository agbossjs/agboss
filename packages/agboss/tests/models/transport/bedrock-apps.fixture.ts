import {
  Agent,
  PiiAction,
  PiiKind,
  PiiPolicy,
  TenantContext,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import type { Class, Provider } from "../../../src/components/injection.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { ChatStart, Reply } from "../../channels/approval.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { BedrockModelProvider, BedrockSdkClient } from "./bedrock-provider.fixture.js";

/** #385: workflows and applications on a transport provider — alone, with PII, in a fallback. */

/** A structured answer: the agent answers through its answer tool. */
export class VerdictDto {
  @Text({ prompt: "the verdict" })
  verdict!: string;
}

@WorkflowFinish({ name: "verdict-workflow-finish", description: "The verdict", output: VerdictDto })
export class VerdictFinish {}

@WorkflowStart({
  name: "verdict-workflow-start",
  description: "A case",
  input: WorkflowStartTextDto,
})
export class VerdictStart {}

/** A desk's workflows and its text agent (for `mockLlm`). */
export interface BedrockDesk {
  readonly workflows: readonly Class[];
  readonly textAgent: Class;
}

/** A text workflow and a verdict workflow (a DTO agent: its answer tool) on a model. */
export function workflowsOn(model: string, prefix: string): BedrockDesk {
  @Agent({ name: `${prefix}-agent`, description: "Answers", prompt: "Answer the message.", model })
  class TextAgent {}

  @Agent({
    name: `${prefix}-verdict-agent`,
    description: "Gives a verdict",
    prompt: "Give a verdict on the message.",
    model,
    output: VerdictDto,
  })
  class VerdictAgent {}

  @Workflow({
    name: `${prefix}-workflow`,
    version: "1.0.0",
    flow: [start(ChatStart).returns(WorkflowStartTextDto).toAgent(TextAgent).toFinish(Reply)],
    defaults: { models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX } },
  })
  class TextWorkflow {}

  @Workflow({
    name: `${prefix}-verdict-workflow`,
    version: "1.0.0",
    flow: [
      start(VerdictStart)
        .returns(WorkflowStartTextDto)
        .toAgent(VerdictAgent)
        .returns(VerdictDto)
        .toFinish(VerdictFinish),
    ],
    defaults: { models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX } },
  })
  class VerdictWorkflow {}

  return { workflows: [TextWorkflow, VerdictWorkflow], textAgent: TextAgent };
}

@PiiPolicy({
  name: "bedrock-contact-pii-policy",
  description: "Hides email addresses from models",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
export class BedrockContactPiiPolicy {}

/** An application of one text workflow on `model`, its providers and budgets. */
export function bedrockApplicationOn(parts: {
  readonly name: string;
  readonly model?: string;
  readonly providers?: readonly Provider[];
  readonly budgets?: readonly Class[];
  readonly piiPolicies?: readonly Class[];
  readonly desk?: BedrockDesk;
}): Class {
  const prefix = parts.name.replace(/-application$/, "");
  @Application({
    name: parts.name,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [...(parts.desk ?? workflowsOn(parts.model ?? "bedrock/claude", prefix)).workflows],
    providers: [...(parts.providers ?? [BedrockModelProvider]), BedrockSdkClient],
    budgets: parts.budgets ?? TEST_BUDGETS,
    ...(parts.piiPolicies === undefined ? {} : { piiPolicies: parts.piiPolicies }),
  })
  class BedrockApplication {}
  return BedrockApplication;
}

export const BEDROCK_DESK = workflowsOn("bedrock/claude", "bedrock-desk");

export const BedrockApplication = bedrockApplicationOn({
  name: "bedrock-desk-application",
  desk: BEDROCK_DESK,
});

const http = {
  timeout: seconds(5),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
};

/** An HTTP backup (no key) with its own prices. */
@ModelProvider({
  ...http,
  name: "backup-385-model-provider",
  description: "An HTTP backup",
  serves: [/^backup\//],
  baseUrl: "http://backup-385.test/v1",
  cost: ModelCost.fromPrices({
    "backup/claude": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
  circuitBreakerPolicy: { failureThreshold: 1, window: minutes(1), openFor: minutes(1) },
})
export class Backup385ModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** An HTTP primary whose breaker falls back to the transport (HTTP → transport). */
@ModelProvider({
  ...http,
  name: "primary-385-model-provider",
  description: "An HTTP primary",
  serves: [/^primary\//],
  baseUrl: "http://primary-385.test/v1",
  cost: ModelCost.fromPrices({
    "primary/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
  circuitBreakerPolicy: {
    failureThreshold: 1,
    window: minutes(1),
    openFor: minutes(1),
    fallback: BedrockModelProvider,
    fallbackModels: { "primary/model": "bedrock/claude" },
  },
})
export class Primary385ModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

export const HttpToTransportApplication = bedrockApplicationOn({
  name: "http-to-transport-application",
  model: "primary/model",
  providers: [Primary385ModelProvider],
});

/** A transport whose breaker falls back to the HTTP backup (transport → HTTP). */
@ModelProvider({
  name: "falling-bedrock-model-provider",
  description: "Bedrock with an HTTP backup",
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "bedrock/claude": { inputPerMillion: usd(3), outputPerMillion: usd(15) },
  }),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: {
    failureThreshold: 1,
    window: minutes(1),
    openFor: minutes(1),
    fallback: Backup385ModelProvider,
    fallbackModels: { "bedrock/claude": "backup/claude" },
  },
  deps: [BedrockSdkClient, TenantContext],
})
export class FallingBedrockModelProvider extends BedrockModelProvider {}

export const TransportToHttpApplication = bedrockApplicationOn({
  name: "transport-to-http-application",
  providers: [FallingBedrockModelProvider],
});
