import type { AgentLoopDeps } from "../../graph/agent-loop/deps.js";
import type { GraphDeps } from "../../graph/deps.js";

/**
 * What an agent's loop takes of the workflow's policies: the PII policies at its model (#120), its
 * input guardrails (#120) and its tool interceptors per tool (#384).
 */
export const loopPoliciesOf = (
  deps: GraphDeps<string>,
  agent: string,
): Pick<AgentLoopDeps, "pii" | "guardrails" | "interceptors"> => ({
  ...(deps.pii === undefined ? {} : { pii: deps.pii.policiesOf(agent) }),
  guardrails: deps.guardrails?.inputOf(agent) ?? [],
  ...(deps.toolInterceptors === undefined
    ? {}
    : { interceptors: deps.toolInterceptors.ofAgent(agent) }),
});
