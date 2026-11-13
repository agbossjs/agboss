import { callerFile } from "../../components/call-site.js";
import type { Class } from "../../components/injection.js";
import type { ToolHandler } from "../../components/decorators.js";
import type { UncompactedTurns } from "../../compaction/compaction.decorator.js";
import type { JudgeHandlerClass } from "../../components/judge-decorators.js";
import type { CacheSetting, MaxTokens, Price } from "../../config/settings-types.js";
import type { BaseMemoryStrategy } from "../../memory/types.js";
import type { Reasoning } from "../../models/reasoning.js";
import { RagMode } from "../../rag/types.js";
import { NodeKind } from "../ast.js";
import type { OutputShape } from "../dto-wrappers.js";
import { declared, recordDeclaration, type InputFields } from "./declaration.js";

export { RagMode };

/** An agent's use of a `@Rag` knowledge base: `{ use: JobsRag, mode: RagMode.Tool }`. */
export interface AgentRag {
  readonly use: Class;
  readonly mode: RagMode;
}

/**
 * `@Agent` — the agent options of today plus `input` / `output` (#270) and `maxVisits`; reasoning
 * only as `Reasoning.off()` / `.on({ effort })` / `.modelDecides()` (#269: no `thinking`), no
 * `compensate`. An interface, not a union, so `satisfies Omit<AgentOptions, "name" | "description">`
 * keeps every field for a shared `*.options.ts` const (#272, 2026-10-16).
 */
export interface AgentOptions {
  /** Ends with `-agent` (`draft-reviewer-agent`); explicit, it keys records and checkpoints. */
  readonly name: string;
  readonly description: string;
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  /** Static `{{key}}` values of the prompt (the same bytes in every execution). */
  readonly promptVariables?: Readonly<Record<string, string>>;
  readonly model: string;
  /** What the agent reads from the path scope, by type. */
  readonly input?: InputFields;
  /** What it answers with; without it, text. What the answers are about is said in the flow (#299). */
  readonly output?: OutputShape;
  /** Visits per execution; one more fails before the model call (`VisitsLimitExceededError`). */
  readonly maxVisits?: number;
  /** `@Tool` or `@McpTool` classes, and question roles (`@ChannelRole({ ask, answer })`, #712). */
  readonly tools?: readonly (
    Class<ToolHandler<never, unknown>> | Class<{ send(ask: never): Promise<unknown> }>
  )[];
  readonly reasoning?: Reasoning;
  readonly rag?: readonly AgentRag[];
  /** A `BaseMemoryStrategy` subclass (`@agboss/core/memory`); the others use the built-in one. */
  readonly memoryStrategy?: Class<BaseMemoryStrategy>;
  readonly price?: Price;
  readonly temperature?: number;
  readonly maxTokens?: MaxTokens;
  readonly cache?: CacheSetting;
  readonly maxToolCalls?: number;
  /** `@Judge` classes. */
  readonly judges?: readonly JudgeHandlerClass[];
  readonly maxRetries?: number;
  /** Guardrails added to the inherited ones (`@Application` → `@Workflow`): `@InputGuardrail` / `@OutputGuardrail` classes. */
  readonly guardrails?: readonly Class[];
  /** Inherited guardrails removed for this agent's own model. */
  readonly excludeGuardrails?: readonly Class[];
  /** PII policies added to the inherited ones; they apply to its model and tools, never to logs and traces. */
  readonly piiPolicies?: readonly Class[];
  /** Inherited PII policies removed for this agent's own model and tools. */
  readonly excludePiiPolicies?: readonly Class[];
  /** Tool interceptors added to the inherited ones, for every call it makes to its tools. */
  readonly toolInterceptors?: readonly Class[];
  /** Inherited tool interceptors removed for this agent. */
  readonly excludeToolInterceptors?: readonly Class[];
  /** Its own `@Compaction`, over the workflow's and the application's. */
  readonly compaction?: Class;
  /** How many recent turns it sees in full, over the workflow's and the application's. */
  readonly uncompactedTurns?: UncompactedTurns;
}

/**
 * An agent: all declaration, an empty class. The options are recorded as written — with a spread
 * from a shared `*.options.ts` const they keep its exact objects, which the analyser (PR 2) matches
 * against that module's exports for `[agent.dynamic-options]`.
 */
export function Agent(options: AgentOptions) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    recordDeclaration(value, declared(NodeKind.Agent, options, source));
    return value;
  };
}
