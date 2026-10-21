import type { ModelSettings } from "../config/types.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { JudgeInstance, JudgeMeta, RunnableJudge } from "./judge-decorators.js";
import { tokenName, type Class } from "./injection.js";
import { ComponentError, componentOf } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { containerFor } from "./runtime.js";

/** A judge class with its `@Judge` settings. */
export interface JudgeClass {
  readonly cls: Class;
  readonly meta: JudgeMeta;
}

function judgeClassOf(agent: string, cls: Class): JudgeClass {
  const component = componentOf(cls);
  if (component?.kind !== "judge") {
    throw new ComponentError(
      `[judge.not-a-judge] @Agent "${agent}": ${tokenName(cls)} in judges is not a @Judge class`,
    );
  }
  // a model is required by the type; plain JS or an empty string still reaches here
  if (typeof component.meta.model !== "string" || component.meta.model.trim() === "") {
    throw new ComponentError(
      `[judge.no-model] @Judge ${tokenName(cls)} ("${component.meta.name}"): no model — set @Judge({ model }); a judge never borrows its agent's model`,
    );
  }
  return { cls, meta: component.meta };
}

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

/** The judges' models as the config holds them (`judges.<name>`). */
export const judgeSettingsOf = (
  judges: ReadonlyMap<string, JudgeClass>,
): Record<string, ModelSettings> =>
  Object.fromEntries([...judges].map(([name, { meta }]) => [name, { model: meta.model }]));

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
          { handler: container.get(cls) as RunnableJudge, reply: meta.reply },
        ]),
      );
    },
  };
}
