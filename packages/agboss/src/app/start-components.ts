import type { Class } from "../components/injection.js";
import { resolveTools, type AssembledWorkflow, type WorkflowServices } from "../workflow.js";
import { channelLookup, containerDepsOf, type ContainerDeps } from "./app-deps-parts.js";
import { codeClassesOf } from "../flow/runtime/graph-model.js";
import { customCompactionClassesOf } from "../compaction/custom-classes.js";
import { judgesFor, knowledgeFor, memoryFor } from "./parts.js";

/** What the container creates at start, as the app's run dependencies. */
type StartComponents = {
  readonly channelOf: ReturnType<typeof channelLookup>;
} & ReturnType<typeof knowledgeFor> &
  ReturnType<typeof memoryFor> &
  ReturnType<typeof judgesFor> &
  ContainerDeps;

/**
 * The graph's code — actions, finishes with a handler, code routers, code arbiters (#279) — its PII
 * policies, its guardrails (#120), its custom compactions (#382) and its tool interceptors (#384),
 * created now, so a missing dependency fails at start.
 */
function createCodeNodes(bundle: AssembledWorkflow, services: WorkflowServices): void {
  const resolve = bundle.resolve(services);
  for (const component of codeClassesOf(bundle.graph)) resolve(component);
  for (const policy of policyClassesOf(bundle)) resolve(policy);
}

/** Its PII policies, guardrails (#120) and tool interceptors (#384). */
const policyClassesOf = (bundle: AssembledWorkflow): readonly Class[] => [
  ...(bundle.pii?.classes ?? []),
  ...(bundle.guardrails?.guardrails ?? []).map((guardrail) => guardrail.type),
  ...customCompactionClassesOf(bundle.compactions),
  ...(bundle.toolInterceptors?.interceptors ?? []).map((interceptor) => interceptor.type),
];

/**
 * The parts of an app its container creates when the app starts (after its tools): code nodes, channels,
 * context knowledge, memory strategies, judges, observers. One function for
 * `createApp` and `agboss check` (#239), so the check fails on a dependency (a provider, a context subclass) exactly
 * when the start would.
 */
export const componentsAtStart = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): StartComponents => {
  createCodeNodes(bundle, services);
  return {
    channelOf: channelLookup(bundle, services),
    ...knowledgeFor(bundle, services),
    ...memoryFor(bundle, services),
    ...judgesFor(bundle, services),
    ...containerDepsOf(bundle, services),
  };
};

/**
 * Every component the app's start creates, with these services (`agboss check`): its tools, then the
 * rest — no model called, no MCP server connected, no lifecycle hook run. Throws what the start
 * would throw, e.g. `[context.not-declared]` for a context subclass the application does not declare.
 */
export function createStartComponents(bundle: AssembledWorkflow, services: WorkflowServices): void {
  resolveTools(bundle, services);
  componentsAtStart(bundle, services);
}
