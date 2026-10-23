import type { AgentsConfigOf } from "../config/types.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import { DecidedBy } from "../flow/decorators/router.js";
import {
  isCodeJudge,
  JudgeModel,
  type JudgeInstance,
  type JudgeMeta,
  type RunnableJudge,
} from "./judge-decorators.js";
import { tokenName, type Class, type Token } from "./injection.js";
import { ComponentError, componentOf } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { containerFor } from "./runtime.js";

/** A judge class with its `@Judge` settings. */
export interface JudgeClass {
  readonly cls: Class;
  readonly meta: JudgeMeta;
}

/** `[judge.no-model]` / `[judge.model-on-code-judge]`: a model judge names one, a code judge none. */
function modelProblemOf(cls: Class, meta: JudgeMeta, deps: readonly Token[]): string | undefined {
  const judge = `@Judge ${tokenName(cls)} ("${meta.name}")`;
  if (isCodeJudge(meta)) {
    // forbidden by the type; plain JS still reaches here
    const { model }: { readonly model?: unknown } = meta;
    if (model !== undefined)
      return `[judge.model-on-code-judge] ${judge}: decided by code (DecidedBy.Code), but it names model ${JSON.stringify(model)} — remove model, or decide by the model (DecidedBy.Model)`;
    if (deps.includes(JudgeModel))
      return `[judge.model-on-code-judge] ${judge}: decided by code (DecidedBy.Code), but it injects JudgeModel — a code judge has no model: remove JudgeModel from deps`;
    return undefined;
  }
  // a model is required by the type; plain JS or an empty string still reaches here
  if (typeof meta.model !== "string" || meta.model.trim() === "")
    return `[judge.no-model] ${judge}: no model — set @Judge({ model }), or decide by code (decidedBy: DecidedBy.Code); a judge never borrows its agent's model`;
  return undefined;
}

/**
 * A `@Judge` class with its settings, checked: a model judge names its model, a code judge (#396)
 * names none and injects no `JudgeModel`. `where` names who lists it (`@Agent "x"`, `testJudge`).
 */
export function checkedJudgeOf(where: string, cls: Class): JudgeClass {
  const component = componentOf(cls);
  if (component?.kind !== "judge") {
    throw new ComponentError(
      `[judge.not-a-judge] ${where}: ${tokenName(cls)} in judges is not a @Judge class`,
    );
  }
  const problem = modelProblemOf(cls, component.meta, component.meta.deps);
  if (problem !== undefined) throw new ComponentError(problem);
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
        throw new ComponentError(
          `[judge.duplicate-name] @Judge "${judge.meta.name}": declared by ${tokenName(known.cls)} and ${tokenName(cls)}`,
        );
      }
      byName.set(judge.meta.name, judge);
    }
  }
  return byName;
}

/** The judges' models as the config holds them (`judges.<name>`): a code judge (#396) has none. */
export function judgeSettingsOf(
  judges: ReadonlyMap<string, JudgeClass>,
): Pick<AgentsConfigOf<string>, "judges"> {
  const models = [...judges].flatMap(([name, { meta }]) =>
    isCodeJudge(meta) ? [] : [[name, { model: meta.model }] as const],
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
            reply: meta.reply,
            decidedBy: meta.decidedBy ?? DecidedBy.Model,
          },
        ]),
      );
    },
  };
}
