import { fileRuntimeOf } from "../../files/file-runtime.js";
import type { AgentDefinition, AgentLoopDeps } from "../../graph/agent-loop/deps.js";
import type { GraphDeps } from "../../graph/deps.js";

/**
 * What an agent's loop takes of the workflow's policies: the PII policies at its model (#120), its
 * input guardrails (#120), its tool interceptors per tool (#384) and the files its model reads (#899).
 */
export const loopPoliciesOf = (
  deps: GraphDeps<string>,
  agent: string,
  definition: AgentDefinition,
): Pick<AgentLoopDeps, "pii" | "guardrails" | "interceptors" | "fileRuntime"> => ({
  fileRuntime: fileRuntimeOf(deps, definition),
  ...(deps.pii === undefined ? {} : { pii: deps.pii.policiesOf(agent) }),
  guardrails: deps.guardrails?.inputOf(agent) ?? [],
  ...(deps.toolInterceptors === undefined
    ? {}
    : { interceptors: deps.toolInterceptors.ofAgent(agent) }),
});
