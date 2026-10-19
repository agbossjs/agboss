import type { Class } from "../../../components/injection.js";
import type { JudgeReplyShape } from "../../../components/judge-decorators.js";
import { componentOf } from "../../../components/metadata.js";
import { PlainTextDto, WorkflowFinishTextDto } from "../../../dto/standard/framework.js";
import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import { Wrapper, type OutputShape } from "../../dto-wrappers.js";
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
  node.declaration.options.output === WorkflowFinishTextDto;

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
      `output: WorkflowFinishTextDto, not to ${edge.to} — give it an output, or end it there`;
    return [violation("flow.text-agent-target", message, [from.name])];
  });
}

/**
 * A judge sees the agent's answer as its DTO (#262 S115): every class the agent may answer with — its
 * `output` class, each `oneOf` variant, `PlainTextDto` for a text agent — is one of its judge's `reply`
 * classes (or extends one), else `[judge.wrong-reply]`; a list output is never judged (a judge's
 * `reply` is one value). A class in `judges` that is not a `@Judge` is `[judge.not-a-judge]` at assembly.
 */

/** The classes a `reply` judges: the class, or each variant of `oneOf(…)`. */
const replyClassesOf = (reply: JudgeReplyShape): readonly DtoClass[] =>
  typeof reply === "function" ? [reply] : reply.variants;

/** The classes an agent answers with, or undefined for a list (one answer holds several values). */
function answerClassesOf(output: OutputShape | undefined): readonly DtoClass[] | undefined {
  if (output === undefined) return [PlainTextDto];
  if (typeof output === "function") return [output];
  return output.kind === Wrapper.OneOf ? output.variants : undefined;
}

/** Whether a value of `answer` is a value of `reply`: the class itself or a subclass. */
const isJudgedBy = (answer: DtoClass, reply: DtoClass): boolean =>
  answer === reply || Object.prototype.isPrototypeOf.call(reply.prototype, answer.prototype);

const outputLabel = (output: OutputShape | undefined): string =>
  output === undefined ? "text (no output: PlainTextDto)" : shapeLabel(output);

function wrongReply(
  agent: FlowNode,
  judge: Class,
  output: OutputShape | undefined,
): RuleViolation[] {
  const meta = componentOf(judge);
  if (meta?.kind !== "judge") return [];
  const answers = answerClassesOf(output);
  const replies = replyClassesOf(meta.meta.reply);
  const what = `${agent.name} answers ${outputLabel(output)}, but its judge ${classLabel(judge)} judges ${shapeLabel(meta.meta.reply)}`;
  if (answers === undefined) {
    const message = `${what} — a judge sees one answer, and a list output has several values: judge the agent's items elsewhere, or remove the judge`;
    return [violation("judge.wrong-reply", message, [agent.name])];
  }
  const unjudged = answers.filter((answer) => !replies.some((reply) => isJudgedBy(answer, reply)));
  if (unjudged.length === 0) return [];
  const missing = unjudged.map(dtoLabel).join(", ");
  const message = `${what} — it does not judge ${missing}: set @Judge({ reply }) to the agent's output (oneOf(…) for its variants, PlainTextDto for a text agent)`;
  return [violation("judge.wrong-reply", message, [agent.name])];
}

export function judgeReplyRules(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Agent) return [];
    const { judges = [], output } = declaration.options;
    return judges.flatMap((judge) => wrongReply(node, judge, output));
  });
}
