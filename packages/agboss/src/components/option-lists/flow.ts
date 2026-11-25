/** The keys of the flow's nodes: @Agent, @Action, @Router, @WorkflowStart, @WorkflowFinish, @Arbiter: each list is held equal to `keyof` its options type (see `option-keys.ts`). */
import type { ActionOptions } from "../../flow/decorators/action.js";
import type { AgentExecutionLimits, AgentOptions } from "../../flow/decorators/agent.js";
import type { ArbiterOptions } from "../../flow/decorators/arbiter.js";
import type { RouterOptions } from "../../flow/decorators/router.js";
import type { WorkflowFinishOptions } from "../../flow/decorators/workflow-finish.js";
import type { WorkflowStartOptions } from "../../flow/decorators/workflow-start.js";
import { optionKeys } from "../option-keys.js";

export const AGENT_KEYS = optionKeys<AgentOptions>()(
  [
    "name",
    "description",
    "prompt",
    "promptVariables",
    "model",
    "modelProvider",
    "input",
    "output",
    "executionLimits",
    "tools",
    "reasoning",
    "rag",
    "temperature",
    "maxTokens",
    "cache",
    "judges",
    "guardrails",
    "excludeGuardrails",
    "piiPolicies",
    "excludePiiPolicies",
    "toolInterceptors",
    "excludeToolInterceptors",
    "memory",
    "files",
  ],
  {
    executionLimits: optionKeys<AgentExecutionLimits>()([
      "maxVisits",
      "maxModelCalls",
      "maxToolCalls",
      "maxRetries",
    ]),
  },
);

export const ACTION_KEYS = optionKeys<ActionOptions>()([
  "name",
  "description",
  "input",
  "output",
  "compensateWith",
  "committedBy",
  "timeout",
  "deps",
]);

export const ROUTER_KEYS = optionKeys<RouterOptions>()([
  "name",
  "description",
  "input",
  "maxVisits",
  "decidedBy",
  "routes",
  "model",
  "modelProvider",
  "prompt",
  "promptVariables",
  "deps",
  "guardrails",
  "excludeGuardrails",
  "piiPolicies",
  "excludePiiPolicies",
  "memory",
]);

export const WORKFLOW_START_KEYS = optionKeys<WorkflowStartOptions>()([
  "name",
  "description",
  "input",
]);

export const WORKFLOW_FINISH_KEYS = optionKeys<WorkflowFinishOptions>()([
  "name",
  "description",
  "output",
]);

export const ARBITER_KEYS = optionKeys<ArbiterOptions>()([
  "name",
  "description",
  "model",
  "modelProvider",
  "prompt",
  "criteria",
  "deps",
]);
