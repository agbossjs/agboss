import type { AgentsConfigOf } from "../config/types.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import { DEFAULT_MODEL_ALIAS } from "../models/model-cascade.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";
import {
  isCodeJudge,
  isDeclarativeJudge,
  type JudgeInstance,
  type JudgeRecord,
  type RunnableJudge,
} from "./judge-decorators.js";
import { tokenName, type Class } from "./injection.js";
import { ComponentError, componentOf } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { containerFor } from "./runtime.js";
import { PromptLoader } from "./prompt-render.js";
import { isInlinePrompt } from "./prompt-source.js";

/** A judge class with its `@Judge` settings. */
export interface JudgeClass {
  readonly cls: Class;
  readonly meta: JudgeRecord;
}

/** `[judge.no-model]`: a model named as an empty string. */
function emptyModelProblemOf(judge: string, meta: JudgeRecord): string | undefined {
  const { model }: { readonly model?: unknown } = meta;
  return typeof model === "string" && model.trim() === ""
    ? `[judge.no-model] ${judge}: an empty model — name one with @Judge({ model }), or leave it out for its provider's default role; a judge never borrows its agent's model`
    : undefined;
}

/**
 * `[judge.model-on-code-judge]`: a judge that injects no `JudgeModel` names no model; `[judge.no-model]`:
 * a model named as an empty string (a model left out is its provider's role, #1313).
 */
function modelProblemOf(cls: Class, meta: JudgeRecord): string | undefined {
  const judge = `@Judge ${tokenName(cls)} ("${meta.name}")`;
  if (isDeclarativeJudge(meta))
    return declarativeProblemOf(cls, meta) ?? emptyModelProblemOf(judge, meta);
  if ((meta as { threshold?: unknown }).threshold !== undefined)
    return `[judge.threshold-without-prompt] ${judge}: threshold scores a declarative judge's model verdict — add a prompt, or remove threshold`;
  // forbidden by the type; plain JS still reaches here
  const { model, modelProvider }: { readonly model?: unknown; readonly modelProvider?: unknown } =
    meta;
  if (!isCodeJudge(meta)) return emptyModelProblemOf(judge, meta);
  if (model === undefined && modelProvider === undefined) return undefined;
  return `[judge.model-on-code-judge] ${judge}: names a model, but it does not inject JudgeModel — a judge with no JudgeModel in deps is decided by code alone: remove model and modelProvider, or add JudgeModel to deps`;
}

const isPromptPart = (part: unknown): boolean =>
  (typeof part === "string" && part.trim() !== "") || isInlinePrompt(part);

/** `[judge.bad-prompt]`, `[judge.bad-threshold]`: what a declarative judge's `prompt` and `threshold` must be. */
function criterionProblemOf(judge: string, meta: JudgeRecord): string | undefined {
  const { prompt, threshold }: { readonly prompt?: unknown; readonly threshold?: unknown } = meta;
  const parts: unknown = Array.isArray(prompt) ? prompt : [prompt];
  if (!Array.isArray(parts) || parts.length === 0 || !parts.every(isPromptPart))
    return `[judge.bad-prompt] ${judge}: prompt is a .prompt.md file ("./criterion.prompt.md"), inline(…), or a non-empty list of them`;
  if (
    threshold !== undefined &&
    !(typeof threshold === "number" && threshold > 0 && threshold <= 1)
  )
    return `[judge.bad-threshold] ${judge}: threshold must be a number in (0, 1] — the score the answer needs; leave it out for a pass or fail verdict`;
  return undefined;
}

/** The option rules of a declarative judge (#1290): an empty class with a `prompt` and a sound `threshold`. */
function declarativeProblemOf(cls: Class, meta: JudgeRecord): string | undefined {
  const judge = `@Judge ${tokenName(cls)} ("${meta.name}")`;
  const problem = criterionProblemOf(judge, meta);
  if (problem !== undefined) return problem;
  if (typeof (cls.prototype as { judge?: unknown }).judge === "function")
    return `[judge.declarative-with-judge] ${judge}: has a prompt and a judge(input) method — a judge is decided by its model (prompt) or by its code (judge), not both: remove one`;
  if (meta.deps.length > 0)
    return `[judge.declarative-with-deps] ${judge}: a declarative judge is an empty class and injects nothing — remove deps, or write judge(input) and drop the prompt`;
  return undefined;
}

/**
 * A `@Judge` class with its settings, checked: a judge that injects no `JudgeModel` (a `$0` code
 * judge) names no model. `where` names who lists it (`@Agent "x"`, `testJudge`).
 */
export function checkedJudgeOf(where: string, cls: Class): JudgeClass {
  const component = componentOf(cls);
  if (component?.kind !== "judge") {
    throw new ComponentError({
      message: `[judge.not-a-judge] ${where}: ${tokenName(cls)} in judges is not a @Judge class`,
    });
  }
  const problem = modelProblemOf(cls, component.meta);
  if (problem !== undefined) throw new ComponentError({ message: problem });
  return { cls, meta: component.meta };
}

const judgeClassOf = (agent: string, cls: Class): JudgeClass =>
  checkedJudgeOf(`@Agent "${agent}"`, cls);

/** An agent's judges by name (`agents.<name>.judges`). */
export const judgeNamesOf = (agent: AgentMeta): string[] =>
  (agent.judges ?? []).map((cls) => judgeClassOf(agent.name, cls).meta.name);

/**
 * Every judge of the agents, by judge name. Assembly fails when a class is not a `@Judge`, has no
 * model, or two classes share a name.
 */
export function judgeClassesOf(agents: readonly AgentMeta[]): ReadonlyMap<string, JudgeClass> {
  const byName = new Map<string, JudgeClass>();
  for (const agent of agents) {
    for (const cls of agent.judges ?? []) {
      const judge = judgeClassOf(agent.name, cls);
      const known = byName.get(judge.meta.name);
      if (known !== undefined && known.cls !== cls) {
        throw new ComponentError({
          message: `[judge.duplicate-name] @Judge "${judge.meta.name}": declared by ${tokenName(known.cls)} and ${tokenName(cls)}`,
        });
      }
      byName.set(judge.meta.name, judge);
    }
  }
  return byName;
}

/**
 * The judges' models as the config holds them (`judges.<name>`): a judge that injects `JudgeModel` has
 * one — the role its provider maps when it names none (#1313); a code judge has none.
 */
export function judgeSettingsOf(
  judges: ReadonlyMap<string, JudgeClass>,
): Pick<AgentsConfigOf<string>, "judges"> {
  const models = [...judges].flatMap(([name, { meta }]) =>
    isCodeJudge(meta)
      ? []
      : [
          [
            name,
            {
              model: meta.model ?? DEFAULT_MODEL_ALIAS,
              ...(meta.modelProvider === undefined
                ? {}
                : { modelProvider: modelProviderOf(meta.modelProvider).name }),
            },
          ] as const,
        ],
  );
  return models.length === 0 ? {} : { judges: Object.fromEntries(models) };
}

/** An agent's judges as assembled: the classes by name, and the criteria of the declarative ones. */
export interface AssembledJudges {
  readonly classes: ReadonlyMap<string, JudgeClass>;
  readonly prompts: ReadonlyMap<string, string>;
}

/**
 * Every declarative judge's criterion, read at assembly like any prompt (#1347): a `./` file relative to
 * the file that declared the judge, `inline(…)`, or a list of them. A problem is the loader's, reported
 * with the agent prompts' at once.
 */
export async function withPromptsOf(
  classes: ReadonlyMap<string, JudgeClass>,
  loader: PromptLoader,
): Promise<AssembledJudges> {
  const loaded = await Promise.all(
    [...classes].flatMap(([name, { meta }]) =>
      meta.prompt === undefined
        ? []
        : [
            loader
              .load({
                label: `@Judge "${name}"`,
                options: { prompt: meta.prompt },
                source: meta.source,
              })
              .then((prompt): [string, string] => [name, prompt]),
          ],
    ),
  );
  return { classes, prompts: new Map(loaded) };
}

/**
 * One declarative judge's criterion outside a workflow assembly (an eval check, a unit test): read as
 * at assembly, with no workflow variables. A judge with code has none.
 */
export async function loadedCriterionOf(
  meta: JudgeRecord,
): Promise<{ readonly prompt: string; readonly threshold?: number } | undefined> {
  if (meta.prompt === undefined) return undefined;
  const loader = new PromptLoader();
  const prompt = await loader.load({
    label: `@Judge "${meta.name}"`,
    options: { prompt: meta.prompt },
    source: meta.source,
  });
  loader.throwIfAny();
  return { prompt, ...(meta.threshold === undefined ? {} : { threshold: meta.threshold }) };
}

/** An agents' judges, checked, with the criteria of the declarative ones read. */
export const judgesOf = (
  agents: readonly AgentMeta[],
  loader: PromptLoader,
): Promise<AssembledJudges> => withPromptsOf(judgeClassesOf(agents), loader);

/** The judges by name, created by the workflow's container (with their `deps`). */
export function judgePartsOf(
  bundle: WorkflowMeta,
  { classes: judges, prompts }: AssembledJudges,
): Pick<AssembledWorkflow, "judges"> {
  if (judges.size === 0) return {};
  return {
    judges: (services: WorkflowServices) => {
      const container = containerFor(bundle, services);
      return new Map(
        [...judges].map(([name, { cls, meta }]): [string, JudgeInstance] => [
          name,
          {
            handler: container.get(cls) as RunnableJudge,
            output: meta.output,
            hasModel: !isCodeJudge(meta),
            ...declaredOf(prompts.get(name), meta.threshold),
          },
        ]),
      );
    },
  };
}

/** A declarative judge's criterion and threshold, as its instance carries them. */
const declaredOf = (
  prompt: string | undefined,
  threshold: number | undefined,
): Pick<JudgeInstance, "declared"> =>
  prompt === undefined
    ? {}
    : { declared: { prompt, ...(threshold === undefined ? {} : { threshold }) } };
