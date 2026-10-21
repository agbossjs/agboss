import {
  defaultSourceOf,
  defaultsLevelsOf,
  uncompactedTurnsSourceOf,
  type DefaultSource,
} from "../config/defaults.js";
import { DEFAULT_MAX_TOKENS } from "../config/types.js";
import { CompactionStrategy } from "../compaction/compaction.decorator.js";
import { memoryPlanOf, type CompactionInUse } from "../compaction/plan.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";
import { workflowDeclarationOf } from "../components/module.js";
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
  section: "models" | "router",
  field: string,
): DefaultSource | undefined {
  const levels = defaultsLevelsOf(bundle.graph);
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

/** Where the window came from: a workflow's or application's `uncompactedTurns`, else the built-in. */
function windowSourceOf(bundle: AssembledWorkflow): DefaultSource | undefined {
  const levels = defaultsLevelsOf(bundle.graph);
  return levels === undefined ? undefined : uncompactedTurnsSourceOf(levels);
}

/** `defaults: temperature 0 (ask-application) · maxTokens 512 (own) · uncompactedTurns 5 (ask-workflow)`. */
export function agentDefaultsLine(bundle: AssembledWorkflow, agent: AgentSettings): string {
  const { defaults } = bundle.config;
  const temperature = agent.temperature ?? defaults.models.temperature;
  const maxTokens = agent.maxTokens ?? defaults.models.maxTokens ?? DEFAULT_MAX_TOKENS;
  const window = agent.uncompactedTurns ?? defaults.uncompactedTurns;
  const parts = [
    `temperature ${String(temperature)} ${sourceLabel(agent.temperature !== undefined, sourceOf(bundle, "models", "temperature"))}`,
    `maxTokens ${String(maxTokens)} ${sourceLabel(agent.maxTokens !== undefined, sourceOf(bundle, "models", "maxTokens"))}`,
    `uncompactedTurns ${String(window)} ${sourceLabel(agent.uncompactedTurns !== undefined, windowSourceOf(bundle))}`,
  ];
  return `    defaults: ${parts.join(" · ")}`;
}

/** The `compaction` an element's own decorator sets; undefined when it sets none. */
function ownCompactionOf(bundle: AssembledWorkflow, element: string): unknown {
  const options: unknown = bundle.graph.nodes.get(element)?.declaration.options;
  return typeof options === "object" && options !== null && "compaction" in options
    ? options.compaction
    : undefined;
}

/**
 * Where an agent's compaction came from (#120 PR 3, #268): its own `compaction`, else its
 * workflow's, else its application's — the single setting's levels, the lowest that sets it wins.
 */
export function compactionSourceOf(bundle: AssembledWorkflow, element: string): string {
  if (ownCompactionOf(bundle, element) !== undefined) return "(own)";
  if (workflowDeclarationOf(bundle.graph.type).options.compaction !== undefined)
    return `(${bundle.config.name})`;
  const application = defaultsLevelsOf(bundle.graph)?.application?.name;
  return application === undefined ? "(application)" : `(${application})`;
}

/** `agboss describe`'s memory section (#120 PR 3): each compaction in use, or the window only. */

/** One compaction in use (#120 PR 3): its strategy, settings, model and window. */
function compactionLine(compaction: CompactionInUse, model: string | undefined): string {
  const queue =
    compaction.strategy === CompactionStrategy.SummaryQueue
      ? `, queue ${String(compaction.summaryQueueLength)}`
      : "";
  return `  ${compaction.name} — ${compaction.strategy} every ${String(compaction.turnsBetweenCompactions)} turns${queue} · summaryMaxTokens ${String(compaction.summaryMaxTokens)} · ${model ?? "?"} · older than ${String(compaction.window)} turns`;
}

/** The compactions that write summaries, or "window only". */
export function memoryLines(bundle: AssembledWorkflow): string[] {
  const plan = memoryPlanOf(bundle.config, bundle.compactions);
  if (plan.compactions.length === 0) return ["memory    window only (no summaries)"];
  return [
    "memory",
    ...plan.compactions.map((compaction) =>
      compactionLine(compaction, bundle.config.compactions?.[compaction.name]?.model?.model),
    ),
  ];
}
