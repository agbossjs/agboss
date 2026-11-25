/** The keys of the components a workflow's nodes use: tools, guards, judges, memory, knowledge, PII, files, budgets, services: each list is held equal to `keyof` its options type (see `option-keys.ts`). */
import type { BudgetOptions } from "../../budgets/budget.js";
import type { FilePolicyOptions } from "../../files/file-policy.js";
import type { MemoryOptions } from "../../memory/memory.decorator.js";
import type {
  CustomPiiPolicyOptions,
  DeclarativePiiPolicyOptions,
} from "../../pii/pii-policy.decorator.js";
import type { RagRerankerOptions } from "../../rag/reranker.decorator.js";
import type { ToolInterceptorOptions } from "../../tool-interceptors/decorator.js";
import type { InjectableOptions, RagOptions, ToolOptions } from "../decorators.js";
import type { ModelJudgeOptions } from "../judge-declaration.js";
import type { JudgeOptions } from "../judge-decorators.js";
import type { GuardrailOptions } from "../policy-decorators.js";
import type { DtoClass } from "../../dto/types.js";
import type { Token } from "../injection.js";
import { optionKeys } from "../option-keys.js";

export const TOOL_KEYS = optionKeys<ToolOptions<DtoClass, DtoClass, readonly Token[]>>()([
  "name",
  "description",
  "approval",
  "readOnly",
  "timeout",
  "maxResultSize",
  "toolInterceptors",
  "excludeToolInterceptors",
  "input",
  "output",
  "deps",
]);

export const TOOL_INTERCEPTOR_KEYS = optionKeys<ToolInterceptorOptions>()([
  "name",
  "description",
  "deps",
]);

export const GUARDRAIL_KEYS = optionKeys<GuardrailOptions>()([
  "name",
  "description",
  "deps",
  "prompt",
  "promptVariables",
  "model",
  "modelProvider",
  "threshold",
  "refusal",
]);

export const JUDGE_KEYS = optionKeys<ModelJudgeOptions | JudgeOptions>()([
  "name",
  "output",
  "description",
  "prompt",
  "threshold",
  "model",
  "modelProvider",
  "deps",
]);

export const MEMORY_KEYS = optionKeys<MemoryOptions>()([
  "name",
  "description",
  "ttl",
  "uncompactedTurns",
  "turnsBetweenCompactions",
  "compaction",
  "deps",
]);

export const RAG_KEYS = optionKeys<RagOptions>()([
  "name",
  "description",
  "scope",
  "topK",
  "reranker",
  "deps",
]);

export const RAG_RERANKER_KEYS = optionKeys<RagRerankerOptions>()([
  "name",
  "description",
  "candidates",
  "maxCandidateLength",
  "onFailure",
  "deps",
  "model",
  "modelProvider",
  "prompt",
]);

export const PII_POLICY_KEYS = optionKeys<DeclarativePiiPolicyOptions | CustomPiiPolicyOptions>()([
  "files",
  "name",
  "description",
  "rules",
  "model",
  "modelProvider",
  "secret",
  "previousSecret",
  "deps",
  "action",
]);

export const FILE_POLICY_KEYS = optionKeys<FilePolicyOptions>()([
  "name",
  "description",
  "ttl",
  "maxFiles",
  "maxFileSize",
  "maxTotalFileSize",
  "allowedMediaTypes",
  "allowedOrigins",
  "fetchTimeout",
  "fetchPool",
]);

export const BUDGET_KEYS = optionKeys<BudgetOptions>()([
  "name",
  "description",
  "deps",
  "scope",
  "workflow",
  "period",
  "maxSpend",
  "maxTokens",
]);

export const INJECTABLE_KEYS = optionKeys<InjectableOptions<readonly Token[]>>()([
  "deps",
  "injectAs",
  "environmentFields",
]);
