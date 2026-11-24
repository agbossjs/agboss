import type { Class } from "../../../components/injection.js";
import type { JudgeOutputShape } from "../../../components/judge-decorators.js";
import { componentOf } from "../../../components/metadata.js";
import { PlainTextDto, WorkflowFinishTextDto } from "../../../dto/standard/framework.js";
import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { Wrapper, type OneOfWrapper, type OutputShape } from "../../dto-wrappers.js";
import { EdgeKind, isTextAgent, type FlowNode } from "../flow-graph.js";
import { classLabel, dtoLabel, shapeLabel } from "../labels.js";
import type { AnalysisContext } from "./context.js";

/**
 * An agent without `output` answers with text (#270 AC10): it leads only to a finish whose `output`
 * is `WorkflowFinishTextDto` — `[flow.text-agent-target]` otherwise. (That it follows only a start of
 * `WorkflowStartTextDto` is its implicit `message` field, checked by `[input.missing-on-path]`.)
 */

const isTextFinish = (node: FlowNode | undefined): boolean =>
  node?.declaration.kind === NodeKind.Finish &&
  (node.declaration.options.output === WorkflowFinishTextDto ||
    node.declaration.options.output === PlainTextDto);

/** The edges a text agent's reply leaves by: its next step, and a launch from it (#273). */
const LEAVING: ReadonlySet<EdgeKind> = new Set([EdgeKind.Next, EdgeKind.Launch, EdgeKind.Join]);

export function textAgentRules(context: AnalysisContext): readonly RuleViolation[] {
  const { graph } = context;
  return graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    if (from === undefined || !isTextAgent(from) || !LEAVING.has(edge.kind)) return [];
    if (isTextFinish(graph.nodes.get(edge.to))) return [];
    const message =
      `${from.name} answers with text (it has no output), so it leads only to a finish with ` +
      `output: WorkflowFinishTextDto (or PlainTextDto), not to ${edge.to} — give it an output, or end it there`;
    return [violation("flow.text-agent-target", message, [from.name])];
  });
}

/**
 * A judge sees the agent's answer as its DTO (#262 S115): the agent's answer and its judge's `output`
 * have one shape — one value (a class, `oneOf`, `PlainTextDto` for a text agent) or a list
 * (`listOf(…)`) — and every class the agent may answer with is one of the judge's `output` classes (or
 * extends one), else `[judge.wrong-output]`. A class in `judges` that is not a `@Judge` is
 * `[judge.not-a-judge]` at assembly.
 */

/** A shape as the rule compares it: whether it is a list, and the classes of its values. */
export interface JudgedShape {
  readonly isList: boolean;
  readonly classes: readonly DtoClass[];
}

/** The classes of one value: the class, or each variant of `oneOf(…)`. */
const classesOfValue = (shape: DtoClass | OneOfWrapper): readonly DtoClass[] =>
  typeof shape === "function" ? [shape] : shape.variants;

/** What a judge's `output` judges, and what an `output` answers (`PlainTextDto` for a text agent). */
export function judgedShapeOf(shape: JudgeOutputShape | OutputShape | undefined): JudgedShape {
  if (shape === undefined) return { isList: false, classes: [PlainTextDto] };
  if (typeof shape !== "function" && shape.kind === Wrapper.List) {
    return { isList: true, classes: classesOfValue(shape.element) };
  }
  return { isList: false, classes: classesOfValue(shape) };
}

/** Whether a value of `answer` is a value of `judged`: the class itself or a subclass. */
export const isJudgedBy = (answer: DtoClass, judged: DtoClass): boolean =>
  answer === judged || Object.prototype.isPrototypeOf.call(judged.prototype, answer.prototype);

const outputLabel = (output: OutputShape | undefined): string =>
  output === undefined ? "text (no output: PlainTextDto)" : shapeLabel(output);

function wrongOutput(
  agent: FlowNode,
  judge: Class,
  output: OutputShape | undefined,
): RuleViolation[] {
  const meta = componentOf(judge);
  if (meta?.kind !== "judge") return [];
  const answers = judgedShapeOf(output);
  const judgedOutputs = judgedShapeOf(meta.meta.output);
  const what = `${agent.name} answers ${outputLabel(output)}, but its judge ${classLabel(judge)} judges ${shapeLabel(meta.meta.output)}`;
  if (answers.isList !== judgedOutputs.isList) {
    const message = answers.isList
      ? `${what} — the agent answers a list: set @Judge({ output: listOf(…) })`
      : `${what} — the judge judges a list, but the agent answers one value: set @Judge({ output }) to the agent's output`;
    return [violation("judge.wrong-output", message, [agent.name])];
  }
  const unjudged = answers.classes.filter(
    (answer) => !judgedOutputs.classes.some((judged) => isJudgedBy(answer, judged)),
  );
  if (unjudged.length === 0) return [];
  const missing = unjudged.map(dtoLabel).join(", ");
  const message = `${what} — it does not judge ${missing}: set @Judge({ output }) to the agent's output (oneOf(…) for its variants, listOf(…) for a list, PlainTextDto for a text agent)`;
  return [violation("judge.wrong-output", message, [agent.name])];
}

export function judgeOutputRules(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Agent) return [];
    const { judges = [], output } = declaration.options;
    return judges.flatMap((judge) => wrongOutput(node, judge, output));
  });
}
