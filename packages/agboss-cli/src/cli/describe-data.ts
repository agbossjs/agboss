import { resolveTools, type AssembledWorkflow } from "agboss";
import {
  childLines,
  configSnapshot,
  describedApplicationOf,
  describedChannelsOf,
  describedLimitsOf,
  describedPiiPoliciesOf,
  describedTreeOf,
  describeServicesWith,
  flowLines,
  inputLines,
  isMcpFacade,
  resolvedModelUsesOf,
  stepsRangeOf,
  shortVersion,
  type AssembledApplication,
  type DescribedEnvironment,
  versionOf,
  workflowSnapshotOf,
} from "agboss/internal";

/**
 * `agboss describe --json`'s `application` (#268 AC4): its tree, each contract's implementation by
 * class name and why, its model providers, channels, budgets, observers, warnings and environment.
 */
export function applicationData(
  assembled: AssembledApplication,
  environment: DescribedEnvironment | undefined,
): Record<string, unknown> {
  const described = describedApplicationOf(assembled);
  const implementations = described.implementations.map((choice) => ({
    contract: choice.contract.name,
    implementation: choice.implementation.name,
    reason: choice.reason,
  }));
  return {
    ...described,
    implementations,
    tree: describedTreeOf(assembled).workflows,
    channels: describedChannelsOf(assembled),
    ...(environment === undefined
      ? {}
      : { environment: { name: environment.name, fields: environment.fields } }),
  };
}

/**
 * `agboss describe --json`: one workflow at a glance, as data (the same facts as the text), and its
 * declarative snapshot (#268 S93): `configHash`, starts, finishes, nodes, edges, `onError`,
 * launches and schemas — the keys its records and events join on.
 */
export function describeData(
  bundle: AssembledWorkflow,
  profile = "base",
  environment?: DescribedEnvironment,
): Record<string, unknown> {
  const c = bundle.config;
  const services = describeServicesWith(environment);
  const tools = resolveTools(bundle, services).map((tool) => ({
    name: tool.name,
    description: tool.description,
    kind: isMcpFacade(tool) ? "mcp" : "local",
    ...(isMcpFacade(tool) ? { server: tool.mcp.server } : {}),
    ...(tool.channel === undefined ? {} : { channel: tool.channel }),
  }));
  const assigned = new Set(Object.values(c.agents).flatMap((agent) => agent.tools ?? []));
  return {
    name: c.name,
    version: c.version,
    profile,
    config: shortVersion(versionOf(configSnapshot(bundle))),
    // its PII policies with their rules and refusals (#120, #268)
    piiPolicies: describedPiiPoliciesOf(bundle),
    flow: flowLines(bundle.graph.flow),
    inputs: inputLines(bundle.graph.analysis),
    // the start each edge into a child workflow enters through (#263)
    children: childLines(bundle.graph.analysis),
    routers: bundle.routers.map((router) => ({
      name: router.name,
      model: router.model,
      description: router.description,
      ...(router.maxVisits === undefined ? {} : { maxVisits: router.maxVisits }),
    })),
    agents: Object.entries(c.agents).map(([name, agent]) => ({
      name,
      model: agent.model,
      description: agent.description,
      tools: agent.tools ?? [],
      rag: (agent.rag ?? []).map((kb) => kb.name),
    })),
    // the provider each model resolves to by `serves` (#266)
    models: resolvedModelUsesOf(bundle),
    tools,
    unassignedTools: tools.map((tool) => tool.name).filter((name) => !assigned.has(name)),
    limits: describedLimitsOf(bundle),
    steps: stepsRangeOf(bundle.graph.analysis.graph),
    ...workflowSnapshotOf(bundle, services),
  };
}
