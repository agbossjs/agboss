import type { Class } from "../components/injection.js";
import {
  guardrailMetaOf,
  GuardrailSide,
  isCodeGuardrail,
  type GuardrailMeta,
} from "../components/policy-decorators.js";
import type { PromptLoader } from "../components/prompt-render.js";
import type { AgentMeta } from "../components/meta-types.js";
import { NodeKind } from "../flow/ast.js";
import { DecidedBy, isCodeRouter } from "../flow/decorators/router.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { throwIfViolated } from "../graph/rule-error.js";
import type { LoadedGuardrail, LoadedGuardrailBase } from "./loaded.js";
import { guardrailModelOf, guardrailViolations } from "./checks.js";
import {
  effectiveGuardrails,
  GuardedElementKind,
  type ElementGuardrailClasses,
  type GuardedElement,
} from "./levels.js";

/**
 * A workflow's guardrails as assembled (#120): each listed class checked, its question read
 * (`prompt` / `promptUrls`, like any prompt at assembly) and its model resolved — its own, else
 * the workflow's `defaults.guardrail.model` — and every agent's and model router's guardrails by
 * side; a code guardrail (#383) has neither question nor model. Any rule broken fails the
 * assembly, all at once.
 */

export {
  isModelGuardrail,
  modelGuardrailsOf,
  type LoadedCodeGuardrail,
  type LoadedGuardrail,
  type LoadedModelGuardrail,
} from "./loaded.js";

/** The guardrails of one agent or model router, by side, in list order. */
export interface ElementGuardrails {
  readonly input: readonly LoadedGuardrail[];
  readonly output: readonly LoadedGuardrail[];
}

/** A workflow's guardrails: by element, and every one listed (the container creates them). */
export interface AssembledGuardrails {
  readonly byElement: ReadonlyMap<string, ElementGuardrails>;
  readonly guardrails: readonly LoadedGuardrail[];
}

/** What the levels are: the application's list, the workflow's and its name. */
export interface GuardrailOwners {
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowName: string;
  /** `defaults.guardrail.model` of the workflow over its application's. */
  readonly defaultModel: string | undefined;
}

/** The agents and routers of the graph, each with what kind of model it has. */
function elementsOf(agents: readonly AgentMeta[], graph: RuntimeGraph): GuardedElement[] {
  const routers = [...graph.nodes.values()].flatMap((node): GuardedElement[] => {
    if (node.declaration.kind !== NodeKind.Router) return [];
    const { options } = node.declaration;
    const kind = isCodeRouter(options)
      ? GuardedElementKind.CodeRouter
      : GuardedElementKind.ModelRouter;
    return [{ ...options, kind }];
  });
  return [...agents.map((agent) => ({ ...agent, kind: GuardedElementKind.Agent })), ...routers];
}

/** The parts every guardrail has, from its record. */
const baseOf = (cls: Class, meta: GuardrailMeta): LoadedGuardrailBase => ({
  type: cls,
  name: meta.name,
  description: meta.description,
  side: meta.side,
  ...(meta.refusal === undefined ? {} : { refusal: meta.refusal }),
});

/** A guardrail as assembled: a code one as is, a model one with its question read and its model. */
export async function loadedGuardrailOf(
  cls: Class,
  defaultModel: string | undefined,
  loader: PromptLoader,
): Promise<LoadedGuardrail[]> {
  const meta = guardrailMetaOf(cls);
  if (meta === undefined) return [];
  if (isCodeGuardrail(meta)) return [{ ...baseOf(cls, meta), decidedBy: DecidedBy.Code }];
  const model = guardrailModelOf(meta, defaultModel);
  if (model === undefined) return [];
  const label = `@${meta.side === GuardrailSide.Input ? "Input" : "Output"}Guardrail "${meta.name}"`;
  const prompt = await loader.load({ label, options: meta, source: meta.source });
  return [
    {
      ...baseOf(cls, meta),
      decidedBy: DecidedBy.Model,
      prompt,
      threshold: meta.threshold,
      model,
      isOwnModel: meta.model !== undefined,
    },
  ];
}

const byElementOf = (
  classes: ReadonlyMap<string, ElementGuardrailClasses>,
  guardrails: readonly LoadedGuardrail[],
): ReadonlyMap<string, ElementGuardrails> => {
  const of = (list: readonly Class[]): LoadedGuardrail[] =>
    list.flatMap((cls) => guardrails.find((guardrail) => guardrail.type === cls) ?? []);
  return new Map(
    [...classes].map(([name, sides]) => [
      name,
      { input: of(sides.input), output: of(sides.output) },
    ]),
  );
};

/** The workflow's guardrails over its application's; a broken rule fails the assembly. */
export async function guardrailPartsOf(
  owners: GuardrailOwners,
  agents: readonly AgentMeta[],
  graph: RuntimeGraph,
  loader: PromptLoader,
): Promise<AssembledGuardrails> {
  const effective = effectiveGuardrails({ ...owners, elements: elementsOf(agents, graph) });
  throwIfViolated([
    ...effective.violations,
    ...guardrailViolations(effective.classes, owners.defaultModel, owners.workflowName),
  ]);
  const guardrails = (
    await Promise.all(
      effective.classes.map((cls) => loadedGuardrailOf(cls, owners.defaultModel, loader)),
    )
  ).flat();
  return { byElement: byElementOf(effective.byElement, guardrails), guardrails };
}
