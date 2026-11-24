import type { Class } from "../../../components/injection.js";
import { isCodeJudge } from "../../../components/judge-decorators.js";
import { componentOf } from "../../../components/metadata.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import type { FlowGraph } from "../flow-graph.js";
import type { AnalysisContext } from "./context.js";

/**
 * A model judge of the same model family as what it judges grades its own family's answers too
 * kindly (self-preference) — the warning `[judge.same-model-family]`, an error under `--strict`
 * (#396 S2 Q9). The family is the slug's vendor prefix (`openai` of `openai/gpt-6`); a model id
 * without one has no family and is never compared. An agent's judges are read against that agent's
 * model; a suite's judges against every agent of the workflow its start opens. A code judge has no
 * model.
 */

/** `openai` of `openai/gpt-6`; undefined for an id without a vendor prefix. */
export function modelFamilyOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  return slash <= 0 ? undefined : model.slice(0, slash);
}

/** An agent a judge reads the answers of: its name and its model. */
export interface JudgedAgent {
  readonly name: string;
  readonly model: string;
}

/** The judge's own model, when it is a model judge. */
function judgeModelOf(judge: Class): { readonly name: string; readonly model: string } | undefined {
  const found = componentOf(judge);
  if (found?.kind !== "judge" || isCodeJudge(found.meta)) return undefined;
  return { name: found.meta.name, model: found.meta.model };
}

/** The warning of one judge against the agents it judges, when one shares its model's family. */
export function sameFamilyWarnings(
  judge: Class,
  agents: readonly JudgedAgent[],
  where: string,
): RuleViolation[] {
  const own = judgeModelOf(judge);
  const family = own === undefined ? undefined : modelFamilyOf(own.model);
  if (own === undefined || family === undefined) return [];
  return agents.flatMap((agent) => {
    if (modelFamilyOf(agent.model) !== family) return [];
    const message =
      `${where}${own.name} (${own.model}) judges ${agent.name}, whose model ${agent.model} is of ` +
      `the same family (${family}) — a judge grades its own family's answers too kindly: give ` +
      "the judge a model of another vendor";
    return [violation("judge.same-model-family", message, [own.name, agent.name])];
  });
}

/** Every agent of a walked workflow, with its model. */
export function agentsOf(graph: FlowGraph): JudgedAgent[] {
  return [...graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Agent
      ? [{ name: node.name, model: node.declaration.options.model }]
      : [],
  );
}

/** The workflow's agents' own judges, each against the agent it judges. */
export function judgeFamilyWarnings(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Agent) return [];
    const agent = { name: node.name, model: declaration.options.model };
    return (declaration.options.judges ?? []).flatMap((judge) =>
      sameFamilyWarnings(judge, [agent], ""),
    );
  });
}
