/**
 * #1122: held agents on an HTTP provider — an agent-level output guardrail alone, an agent-level PII
 * block rule, an application-level one — each on a model the 127.0.0.1 test server answers.
 */
import { Agent, Workflow } from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { TokenLimit } from "../../src/config/types.js";
import { ChatStart, Reply } from "../channels/approval.workflow.js";
import { onStart } from "../helpers/flow.js";
import {
  StreamBackupModelProvider,
  StreamModelProvider,
} from "../models/streaming/http-streaming.fixture.js";
import {
  bedrockApplicationOn,
  type BedrockDesk,
} from "../models/transport/bedrock-apps.fixture.js";
import { AuditCardPiiPolicy, ForbiddenWordGuardrail } from "./guarded.fixture.js";

export { ForbiddenWordGuardrail };

/** What the held variants differ in. */
export interface HeldKind {
  readonly name: string;
  readonly agent: {
    readonly guardrails?: readonly Class[];
    readonly piiPolicies?: readonly Class[];
  };
  readonly appPii?: readonly Class[];
}

/** The variants: a guardrail alone, a PII block rule on the agent, the same on the application. */
export const HELD_KINDS: readonly HeldKind[] = [
  { name: "an output guardrail alone", agent: { guardrails: [ForbiddenWordGuardrail] } },
  { name: "an agent-level PII block rule", agent: { piiPolicies: [AuditCardPiiPolicy] } },
  { name: "an application-level PII block rule", agent: {}, appPii: [AuditCardPiiPolicy] },
];

/** An application of one text agent on `stream/model` with `kind`'s checks. */
export function heldApplication(
  kind: HeldKind,
  index: number,
  on: "http" | "transport" = "http",
): Class {
  const model = on === "http" ? "stream/model" : "bedrock/claude";
  const prefix = `held-${on}-${String(index)}`;
  @Agent({
    name: `${prefix}-agent`,
    description: "Answers",
    prompt: "Answer the message.",
    model,
    ...kind.agent,
  })
  class HeldAgent {}

  @Workflow({
    name: `${prefix}-workflow`,
    version: "1.0.0",
    flow: [onStart(ChatStart).toAgent(HeldAgent).toFinish(Reply)],
    defaults: { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } },
  })
  class HeldWorkflow {}

  const desk: BedrockDesk = { workflows: [HeldWorkflow], textAgent: HeldAgent };
  return bedrockApplicationOn({
    name: `${prefix}-application`,
    desk,
    ...(on === "http" ? { providers: [StreamModelProvider, StreamBackupModelProvider] } : {}),
    ...(kind.appPii === undefined ? {} : { piiPolicies: kind.appPii }),
  });
}
