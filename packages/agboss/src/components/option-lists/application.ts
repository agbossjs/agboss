/** The keys of @Application, @Workflow and their `defaults`: each list is held equal to `keyof` its options type (see `option-keys.ts`). */
import type {
  ApplicationExecutionLimits,
  ApplicationOptions,
} from "../../application/application.js";
import type { FileDefaults } from "../../files/model-files.js";
import type {
  ApplicationDefaults,
  ChildWorkflowDefaults,
  FlowDefaults,
  GuardrailDefaults,
  ModelDefaults,
  RouterDefaults,
  ToolDefaults,
  WorkflowDefaults,
  WorkflowOptions,
} from "../../flow/decorators/workflow.js";
import { optionKeys } from "../option-keys.js";

const MODEL_DEFAULTS = optionKeys<ModelDefaults>()([
  "model",
  "temperature",
  "maxTokens",
  "reasoning",
  "cache",
]);

const ROUTER_DEFAULTS = optionKeys<RouterDefaults>()(["model"]);

const GUARDRAIL_DEFAULTS = optionKeys<GuardrailDefaults>()(["model"]);

const TOOL_DEFAULTS = optionKeys<ToolDefaults>()(["maxToolCalls", "maxResultSize"]);

const FLOW_DEFAULTS = optionKeys<FlowDefaults>()(["maxPathDepth"]);

const FILE_DEFAULTS = optionKeys<FileDefaults>()([
  "sources",
  "views",
  "maxFileSize",
  "maxTotalFileSize",
  "maxFiles",
  "allowedMediaTypes",
  "answerFiles",
  "guardToolResultFiles",
  "transcriptionModel",
  "redactionModel",
  "redactionValues",
  "transcriptionMaxTokens",
]);

const CHILD_DEFAULTS = optionKeys<ChildWorkflowDefaults>()(["placement"]);

const WORKFLOW_DEFAULTS = optionKeys<WorkflowDefaults>()(
  ["files", "models", "router", "guardrail", "tools", "flow"],
  {
    files: FILE_DEFAULTS,
    models: MODEL_DEFAULTS,
    router: ROUTER_DEFAULTS,
    guardrail: GUARDRAIL_DEFAULTS,
    tools: TOOL_DEFAULTS,
    flow: FLOW_DEFAULTS,
  },
);

const APPLICATION_DEFAULTS = optionKeys<ApplicationDefaults>()(
  ["files", "models", "router", "guardrail", "tools", "flow", "workflows"],
  {
    files: FILE_DEFAULTS,
    models: MODEL_DEFAULTS,
    router: ROUTER_DEFAULTS,
    guardrail: GUARDRAIL_DEFAULTS,
    tools: TOOL_DEFAULTS,
    flow: FLOW_DEFAULTS,
    workflows: CHILD_DEFAULTS,
  },
);

export const APPLICATION_KEYS = optionKeys<ApplicationOptions>()(
  [
    "name",
    "version",
    "workflows",
    "providers",
    "promptVariables",
    "channels",
    "channelSelectors",
    "channelListeners",
    "services",
    "storage",
    "budgets",
    "observers",
    "healthChecks",
    "workingCalendar",
    "modelProvider",
    "mesh",
    "endpoints",
    "executionLimits",
    "isolatedWorker",
    "retention",
    "environment",
    "tenantContext",
    "executionContext",
    "piiPolicies",
    "guardrails",
    "toolInterceptors",
    "piiKeyField",
    "defaults",
  ],
  {
    executionLimits: optionKeys<ApplicationExecutionLimits>()([
      "childClaimTimeout",
      "shutdownTimeout",
      "maxConcurrentSteps",
      "compensationTimeout",
    ]),
    defaults: APPLICATION_DEFAULTS,
  },
);

export const WORKFLOW_KEYS = optionKeys<WorkflowOptions>()(
  [
    "name",
    "version",
    "flow",
    "maxSteps",
    "maxDepth",
    "maxConcurrentExecutions",
    "defaults",
    "placement",
    "budget",
    "modelProvider",
    "providers",
    "services",
    "piiPolicies",
    "excludePiiPolicies",
    "guardrails",
    "toolInterceptors",
    "excludeToolInterceptors",
    "memory",
    "filePolicy",
    "promptVariables",
  ],
  { defaults: WORKFLOW_DEFAULTS },
);
