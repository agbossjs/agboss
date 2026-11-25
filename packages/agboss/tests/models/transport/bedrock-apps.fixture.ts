import {
  Agent,
  PiiKind,
  PiiPolicy,
  TenantContext,
  TokenLimit,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import type { Class, Provider } from "../../../src/components/injection.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { ChatStart, Reply } from "../../channels/approval.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { BedrockModelProvider, BedrockSdkClient } from "./bedrock-provider.fixture.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";

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

/** What the tool agent's tool is asked (#1231). */
export class LookupRequest {
  @Text({ prompt: "what to look up" })
  query!: string;
}

/** What the tool agent's tool answers. */
export class LookupFound {
  @Text()
  found!: string;
}

@WorkflowStart({
  name: "lookup-workflow-start",
  description: "A question the tool agent answers",
  input: WorkflowStartTextDto,
})
export class LookupStart {}

/** The name of the tool agent's tool on the desk of `prefix`. */
export const lookupToolOf = (prefix: string): string => `${prefix}-lookup-tool`;

/** A desk's workflows and its text agent (for `mockModel`). */
export interface BedrockDesk {
  readonly workflows: readonly Class[];
  readonly textAgent: Class;
}

/**
 * A text workflow, a verdict workflow (a DTO agent: its answer tool) and a lookup workflow (an
 * agent with a tool, #1231) on a model.
 */
export function workflowsOn(model: string, prefix: string): BedrockDesk {
  @Agent({
    name: `${prefix}-agent`,
    description: "Answers",
    prompt: inline("Answer the message."),
    model,
  })
  class TextAgent {}

  @Agent({
    name: `${prefix}-verdict-agent`,
    description: "Gives a verdict",
    prompt: inline("Give a verdict on the message."),
    model,
    output: VerdictDto,
  })
  class VerdictAgent {}

  @Tool({
    name: lookupToolOf(prefix),
    description: "Looks a thing up",
    input: LookupRequest,
    output: LookupFound,
  })
  class LookupTool {
    execute({ query }: LookupRequest): Promise<LookupFound> {
      return Promise.resolve({ found: `found ${query}` });
    }
  }

  @Agent({
    name: `${prefix}-lookup-agent`,
    description: "Answers, looking things up",
    prompt: inline("Answer the message; look things up when you need to."),
    model,
    tools: [LookupTool],
  })
  class LookupAgent {}

  @Workflow({
    name: `${prefix}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(ChatStart).toAgent(TextAgent).toFinish(Reply)],
    defaults: { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } },
  })
  class TextWorkflow {}

  @Workflow({
    name: `${prefix}-verdict-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(VerdictStart).toAgent(VerdictAgent).toFinish(VerdictFinish)],
    defaults: { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } },
  })
  class VerdictWorkflow {}

  @Workflow({
    name: `${prefix}-lookup-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(LookupStart).toAgent(LookupAgent).toFinish(Reply)],
    defaults: { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } },
  })
  class LookupWorkflow {}

  return { workflows: [TextWorkflow, VerdictWorkflow, LookupWorkflow], textAgent: TextAgent };
}

@PiiPolicy({
  name: "bedrock-contact-pii-policy",
  description: "Hides email addresses from models",
  rules: [PiiKind.Email.mask()],
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
    modelProvider: (parts.providers ?? [BedrockModelProvider])[0] as Class,
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
};

/** An HTTP backup (no key) with its own prices. */
@ModelProvider({
  ...http,
  name: "backup-385-model-provider",
  description: "An HTTP backup",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://backup-385.test/v1" }),
  cost: ModelCost.fromPrices({
    "backup/claude": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 1,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
})
export class Backup385ModelProvider {}

/** An HTTP primary whose breaker falls back to the transport (HTTP → transport). */
@ModelProvider({
  ...http,
  name: "primary-385-model-provider",
  description: "An HTTP primary",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://primary-385.test/v1" }),
  cost: ModelCost.fromPrices({
    "primary/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 1,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
  fallback: { provider: BedrockModelProvider, models: { "primary/model": "bedrock/claude" } },
})
export class Primary385ModelProvider {}

export const HttpToTransportApplication = bedrockApplicationOn({
  name: "http-to-transport-application",
  model: "primary/model",
  providers: [Primary385ModelProvider],
});

/** A transport whose breaker falls back to the HTTP backup (transport → HTTP). */
@ModelProvider({
  name: "falling-bedrock-model-provider",
  description: "Bedrock with an HTTP backup",
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "bedrock/claude": { inputPerMillion: usd(3), outputPerMillion: usd(15) },
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 1,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
  fallback: { provider: Backup385ModelProvider, models: { "bedrock/claude": "backup/claude" } },
  deps: [BedrockSdkClient, TenantContext],
})
export class FallingBedrockModelProvider extends BedrockModelProvider {}

export const TransportToHttpApplication = bedrockApplicationOn({
  name: "transport-to-http-application",
  providers: [FallingBedrockModelProvider],
});
