import type { ResolvedAll, Token } from "./injection.js";
import { recordComponent } from "./metadata.js";

/** PII policies and guardrails: created by the workflow's container with their `deps`. */

// --- Guardrails & PII Policies ---

export interface PiiPolicy {
  mask(text: string): Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  maskJson(obj: any): Promise<any>;
}

/**
 * What a guardrail is shown at its point: the agent, the tool call (or the reply). The execution
 * — its tenant, its project fields — comes through the constructor (`deps: [ExecutionContext]`).
 */
export interface GuardrailContext {
  agent: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call?: any;
  replyWith?: string;
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

export function PiiPolicy<const D extends readonly Token[] = []>(options: {
  name: string;
  deps?: D;
}) {
  return <C extends new (...args: ResolvedAll<D>) => PiiPolicy>(value: C): C => {
    recordComponent(value, {
      kind: "pii-policy",
      meta: { name: options.name, deps: options.deps ?? [] },
    });
    return value;
  };
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
