import { resolveTools, type AssembledWorkflow } from "agboss";
import {
  childLines,
  configSnapshot,
  describeServicesWith,
  flowLines,
  inputLines,
  isMcpFacade,
  resolvedModelUsesOf,
  stepsRangeOf,
  shortVersion,
  type DescribedEnvironment,
  versionOf,
} from "agboss/internal";

/** `agboss describe --json`: the workflow at a glance, as data (the same facts as the text). */
export function describeData(
  bundle: AssembledWorkflow,
  profile = "base",
  environment?: DescribedEnvironment,
): Record<string, unknown> {
  const c = bundle.config;
  const tools = resolveTools(bundle, describeServicesWith(environment)).map((tool) => ({
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
    ...(environment === undefined
      ? {}
      : { environment: { name: environment.name, fields: environment.fields } }),
    config: shortVersion(versionOf(configSnapshot(bundle))),
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
    limits: { maxSteps: bundle.maxSteps },
    steps: stepsRangeOf(bundle.graph.analysis.graph),
  };
}
