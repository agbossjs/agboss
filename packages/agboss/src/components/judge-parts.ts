import type { AgentsConfigOf } from "../config/types.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import { DEFAULT_MODEL_ALIAS } from "../models/model-cascade.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";
import {
  isCodeJudge,
  type JudgeInstance,
  type JudgeRecord,
  type RunnableJudge,
} from "./judge-decorators.js";
import { tokenName, type Class } from "./injection.js";
import { ComponentError, componentOf } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { containerFor } from "./runtime.js";

/** A judge class with its `@Judge` settings. */
export interface JudgeClass {
  readonly cls: Class;
  readonly meta: JudgeRecord;
}

/**
 * `[judge.model-on-code-judge]`: a judge that injects no `JudgeModel` names no model; `[judge.no-model]`:
 * a model named as an empty string (a model left out is its provider's role, #1313).
 */
function modelProblemOf(cls: Class, meta: JudgeRecord): string | undefined {
  const judge = `@Judge ${tokenName(cls)} ("${meta.name}")`;
  // forbidden by the type; plain JS still reaches here
  const { model, modelProvider }: { readonly model?: unknown; readonly modelProvider?: unknown } =
    meta;
  if (!isCodeJudge(meta)) {
    if (typeof model === "string" && model.trim() === "")
      return `[judge.no-model] ${judge}: an empty model — name one with @Judge({ model }), or leave it out for its provider's default role; a judge never borrows its agent's model`;
    return undefined;
  }
  if (model === undefined && modelProvider === undefined) return undefined;
  return `[judge.model-on-code-judge] ${judge}: names a model, but it does not inject JudgeModel — a judge with no JudgeModel in deps is decided by code alone: remove model and modelProvider, or add JudgeModel to deps`;
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

/** The judges by name, created by the workflow's container (with their `deps`). */
export function judgePartsOf(
  bundle: WorkflowMeta,
  judges: ReadonlyMap<string, JudgeClass>,
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
          },
        ]),
      );
    },
  };
}
