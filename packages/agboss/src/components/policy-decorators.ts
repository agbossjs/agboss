import type { ResolvedAll, Token } from "./injection.js";
import { recordComponent } from "./metadata.js";

/** Guardrails: created by the workflow's container with their `deps`. */

// --- Guardrails ---

/**
 * What a guardrail is shown at its point: the agent, the tool call (or the reply). The execution
 * — its tenant, its project fields — comes through the constructor (`deps: [ExecutionContext]`).
 */
export interface GuardrailContext {
  /** The agent whose loop it is. */
  agent: string;
  /** The tool call (`{ name, args }`); none before the agent's answer. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call?: any;
  /** The agent's answer, at `beforeAgentAnswer`. */
  replyWith?: string;
  /** The execution's id. */
  runId?: string;
}

export interface Guardrail {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type, @typescript-eslint/no-explicit-any
  beforeToolCall?: (ctx: GuardrailContext) => Promise<void | { overrideArguments?: any }>;
  afterToolCall?: (ctx: GuardrailContext) => Promise<void>;
  onChannelDecision?: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    decision: any,
    ctx: GuardrailContext,
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type, @typescript-eslint/no-explicit-any
  ) => Promise<void | { overrideArguments?: any }>;
  beforeAgentAnswer?: (ctx: GuardrailContext) => Promise<void>;
}

export function Guardrail<const D extends readonly Token[] = []>(options: {
  name: string;
  deps?: D;
}) {
  return <C extends new (...args: ResolvedAll<D>) => Guardrail>(value: C): C => {
    recordComponent(value, {
      kind: "guardrail",
      meta: { name: options.name, deps: options.deps ?? [] },
    });
    return value;
  };
}
