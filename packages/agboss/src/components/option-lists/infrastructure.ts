/** The keys of the infrastructure and the contracts an application serves or calls: each list is held equal to `keyof` its options type (see `option-keys.ts`). */
import type { A2AAgentConfig } from "../../a2a/a2a-decorator.js";
import type { A2AEndpointOptions } from "../../a2a/a2a-endpoint.decorator.js";
import type { EvalSuiteOptions } from "../../eval/suite/eval-suite.decorator.js";
import type { HttpAuthenticatorOptions } from "../../http/http-authenticator.js";
import type { McpEndpointOptions } from "../../mcp/mcp-endpoint.decorator.js";
import type { MeshOptions } from "../../mesh/mesh.decorator.js";
import type { ModelProviderOptions } from "../../models/model-provider.decorator.js";
import type {
  ClusterStorageOptions,
  DatabaseStorageOptions,
  ObjectStorageOptions,
} from "../../storage/storage-decorators.js";
import type { McpServerOptions } from "../decorators.js";
import type { ServerTools } from "../mcp-client.js";
import { optionKeys } from "../option-keys.js";

export const MODEL_PROVIDER_KEYS = optionKeys<ModelProviderOptions>()([
  "name",
  "description",
  "serves",
  "timeout",
  "cost",
  "retryPolicy",
  "rateLimitPolicy",
  "circuitBreakerPolicy",
  "fallback",
  "baseUrl",
  "baseUrlField",
  "apiKey",
  "reasoning",
  "promptCaching",
  "deps",
  "driver",
  "model",
  "models",
]);

export const MCP_SERVER_KEYS = optionKeys<
  McpServerOptions<ServerTools> & { readonly injectAs?: readonly unknown[] }
>()([
  "name",
  "tools",
  "injectAs",
  "transport",
  "target",
  "timeout",
  "costPerCall",
  "maxConcurrentCalls",
  "command",
  "args",
  "env",
  "inheritSystemEnv",
  "url",
  "headers",
]);

export const MCP_ENDPOINT_KEYS = optionKeys<McpEndpointOptions>()([
  "name",
  "version",
  "description",
  "tools",
]);

export const A2A_AGENT_KEYS = optionKeys<A2AAgentConfig>()([
  "name",
  "url",
  "headers",
  "timeout",
  "target",
  "costPerCall",
  "mesh",
  "allowedOrigins",
  "deps",
  "injectAs",
  "input",
  "output",
]);

export const A2A_ENDPOINT_KEYS = optionKeys<A2AEndpointOptions>()([
  "name",
  "version",
  "description",
  "ttl",
  "skills",
  "defaultSkill",
  "provider",
  "cardFileFields",
]);

export const MESH_KEYS = optionKeys<MeshOptions>()([
  "name",
  "description",
  "signingKey",
  "inboundMode",
  "deduplicationTtl",
  "maxHops",
  "envelopeTtl",
  "maxClockSkew",
  "peers",
]);

export const HTTP_AUTHENTICATOR_KEYS = optionKeys<HttpAuthenticatorOptions>()([
  "name",
  "description",
  "schemes",
  "deps",
]);

export const DATABASE_STORAGE_KEYS = optionKeys<DatabaseStorageOptions>()([
  "name",
  "description",
  "driver",
  "auditLogTtl",
  "ledgerEntriesTtl",
  "idempotencySecret",
  "previousIdempotencySecret",
  "piiSecret",
  "previousPiiSecret",
]);

export const CLUSTER_STORAGE_KEYS = optionKeys<ClusterStorageOptions>()([
  "name",
  "description",
  "driver",
]);

export const OBJECT_STORAGE_KEYS = optionKeys<ObjectStorageOptions>()([
  "name",
  "description",
  "driver",
]);

export const EVAL_SUITE_KEYS = optionKeys<EvalSuiteOptions>()([
  "name",
  "description",
  "start",
  "judges",
  "tools",
  "modelProvider",
  "beforeAttempt",
  "afterAttempt",
  "cascade",
  "cases",
]);
