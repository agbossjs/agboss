import { callerFile } from "../../components/call-site.js";
import type { Class } from "../../components/injection.js";
import type { AgentMeta, PolicyFields } from "../../components/meta-types.js";
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
export interface AgentOptions extends PolicyFields {
  /** Ends with `-agent` (`draft-reviewer-agent`); explicit, it keys records and checkpoints. */
  readonly name: string;
  readonly description: string;
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  /** Static `{{key}}` values of the prompt (the same bytes in every execution). */
  readonly promptVariables?: AgentMeta["promptVariables"];
  readonly model: string;
  /** What the agent reads from the path scope, by type. */
  readonly input?: InputFields;
  /** What it answers with; without it, text. What the answers are about is said in the flow (#299). */
  readonly output?: OutputShape;
  /** Visits per execution; one more fails before the model call (`VisitsLimitExceededError`). */
  readonly maxVisits?: number;
  readonly tools?: AgentMeta["tools"];
  readonly reasoning?: Reasoning;
  readonly rag?: readonly AgentRag[];
  readonly memoryStrategy?: AgentMeta["memoryStrategy"];
  readonly price?: AgentMeta["price"];
  readonly temperature?: number;
  readonly maxTokens?: AgentMeta["maxTokens"];
  readonly cache?: AgentMeta["cache"];
  readonly historyLimit?: number;
  readonly historySummaries?: number;
  readonly maxToolCalls?: number;
  readonly judges?: AgentMeta["judges"];
  readonly maxRetries?: number;
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
