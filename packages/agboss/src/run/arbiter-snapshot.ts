import { normalisePromptText } from "../components/prompt-render.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { arbiterOf, isDeclarativeArbiter } from "../flow/decorators/arbiter.js";
import {
  arbiterClassesOf,
  modelArbitersOf,
  type ModelArbiterUse,
} from "../flow/runtime/launch/runtime-launch.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { AgentExecutionDeps } from "./types.js";

/** The model arbiters with their resolved models (#1313); an execution without them reads the declared ones. */
export const arbitersOf = (
  deps: Pick<AgentExecutionDeps<string>, "arbiters" | "graph">,
): readonly ModelArbiterUse[] => deps.arbiters ?? modelArbitersOf(deps.graph.launches);

/** The model arbiters' models for the model version, never their prompts: those are the prompt version's. */
export const arbiterModelsOf = (
  deps: Pick<AgentExecutionDeps<string>, "arbiters" | "graph">,
): readonly object[] =>
  arbitersOf(deps).map((use) =>
    Object.fromEntries(Object.entries(use).filter(([key]) => key !== "prompt")),
  );

/** One model arbiter's texts as hashed. */
export interface ArbiterText {
  readonly name: string;
  readonly prompt: string;
  readonly criteria: readonly { readonly target: string; readonly prompt: string }[];
}

/** The model arbiters' texts (#279): their prompt and each agent's criterion, by name. */
export function arbiterTexts(
  graph: RuntimeGraph,
  uses: readonly ModelArbiterUse[] = [],
): readonly ArbiterText[] {
  return arbiterClassesOf(graph.launches).flatMap((arbiter) => {
    const options = arbiterOf(arbiter)?.options;
    if (options === undefined || !isDeclarativeArbiter(options)) return [];
    const criteria = options.criteria.map(({ target, prompt }) => ({
      target: declarationOf(target)?.options.name ?? target.name,
      prompt: normalisePromptText(prompt),
    }));
    // the text assembly read (#1347): a file's text, never its path
    const prompt = uses.find((use) => use.name === options.name)?.prompt ?? "";
    return [{ name: options.name, prompt: normalisePromptText(prompt), criteria }];
  });
}
