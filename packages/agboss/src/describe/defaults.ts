import { defaultSourceOf, type DefaultSource } from "../config/defaults.js";
import { DEFAULT_MAX_TOKENS } from "../config/types.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * Where `agboss describe`'s values came from (#261 AC12): a component's own field, the `defaults`
 * of its workflow or application, or the framework's built-in.
 */

type AgentSettings = AssembledWorkflow["config"]["agents"][string];

/** `(own)`, `(ask-workflow)` / `(ask-application)`, or `(built-in)`. */
const sourceLabel = (own: boolean, source: DefaultSource | undefined): string =>
  own ? "(own)" : source === undefined ? "(built-in)" : `(${source.name})`;

function sourceOf(
  bundle: AssembledWorkflow,
  section: "models" | "history" | "router",
  field: string,
): DefaultSource | undefined {
  const levels = bundle.defaultsLevels;
  return levels === undefined ? undefined : defaultSourceOf(levels, section, field);
}

/** A router's model and where it came from: its own, or `defaults.router.model` of a level. */
export function routerModelSource(bundle: AssembledWorkflow, router: LoadedRouter): string {
  const node = bundle.graph.nodes.get(router.name);
  const options: unknown = node?.declaration.options;
  const own = typeof options === "object" && options !== null && "model" in options;
  if (own) return "(own)";
  const source = sourceOf(bundle, "router", "model");
  return source === undefined
    ? "(defaults.router.model)"
    : `(defaults.router.model of ${source.name})`;
}

/** `defaults: temperature 0 (ask-application) · maxTokens 512 (own) · history 5 (ask-workflow)`. */
export function agentDefaultsLine(bundle: AssembledWorkflow, agent: AgentSettings): string {
  const { defaults } = bundle.config;
  const temperature = agent.temperature ?? defaults.models.temperature;
  const maxTokens = agent.maxTokens ?? defaults.models.maxTokens ?? DEFAULT_MAX_TOKENS;
  const history = agent.historyLimit ?? defaults.history.limit;
  const parts = [
    `temperature ${String(temperature)} ${sourceLabel(agent.temperature !== undefined, sourceOf(bundle, "models", "temperature"))}`,
    `maxTokens ${String(maxTokens)} ${sourceLabel(agent.maxTokens !== undefined, sourceOf(bundle, "models", "maxTokens"))}`,
    `history ${String(history)} ${sourceLabel(agent.historyLimit !== undefined, sourceOf(bundle, "history", "limit"))}`,
  ];
  return `    defaults: ${parts.join(" · ")}`;
}
