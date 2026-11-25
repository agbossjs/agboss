import { PAUSE_TIMERS_EVERY } from "../../application/pause-timers.js";
import { isRemindBefore } from "../../channels/channel-rules.js";
import { pauseTargetOf, type PauseTargetOptions } from "../../channels/pause-targets.js";
import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind } from "../ast.js";
import type { AnalysisContext } from "./rules/context.js";

/**
 * The warning `[pause.remind-before-below-tick]` (#1099): a target's `remindBefore` shorter than the
 * pause timers' tick (`PAUSE_TIMERS_EVERY`, 5 s) — the reminder's window `[deadline − remindBefore,
 * deadline)` is then shorter than the look's period, so a tick can fall on none of it and the
 * reminder is skipped without a trace. A warning, an error under `--strict`.
 */

const belowTickMessage = (target: string, remindBefore: number): string =>
  `${target}: remindBefore (${String(remindBefore)} ms) is shorter than the pause timers' tick (${String(PAUSE_TIMERS_EVERY)} ms) — its reminder can be skipped; use at least ${String(PAUSE_TIMERS_EVERY)} ms`;

/** The tools of the agents of the workflow, each class once. */
function toolsOf(context: AnalysisContext): readonly Class[] {
  const tools = [...context.graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Agent ? (node.declaration.options.tools ?? []) : [],
  );
  return [...new Set(tools)];
}

/** The targets of the workflow's external-task steps and of its tools' approvals, each once. */
function targetsOf(context: AnalysisContext): readonly PauseTargetOptions[] {
  const fromSteps = [...context.graph.nodes.values()].flatMap((node) => {
    const options =
      node.kind === NodeKind.Question ? pauseTargetOf(node.component)?.options : undefined;
    return options === undefined ? [] : [options];
  });
  const fromTools = toolsOf(context).flatMap((cls) => {
    const component = componentOf(cls);
    const approval = component?.kind === "tool" ? component.meta.approval : undefined;
    const options = approval === undefined ? undefined : pauseTargetOf(approval)?.options;
    return options === undefined ? [] : [options];
  });
  return [
    ...new Map([...fromSteps, ...fromTools].map((options) => [options.name, options])).values(),
  ];
}

/** `[pause.remind-before-below-tick]` over the targets a workflow's pauses use. */
export const remindBeforeWarnings = (context: AnalysisContext): readonly RuleViolation[] =>
  targetsOf(context).flatMap(({ name, remindBefore }) =>
    typeof remindBefore === "number" &&
    isRemindBefore(remindBefore) &&
    remindBefore < PAUSE_TIMERS_EVERY
      ? [violation("pause.remind-before-below-tick", belowTickMessage(name, remindBefore), [name])]
      : [],
  );
