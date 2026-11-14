import type { Class } from "../../components/injection.js";
import { isExpiresIn } from "../../channels/channel-rules.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import type { Milliseconds } from "../../units/index.js";
import { NodeKind, StepKind, type FlowPath, type Step } from "../ast.js";
import { subPathsOf } from "./child-placements.js";
import type { FlowNode } from "./flow-graph.js";
import type { AnalysisContext } from "./rules/context.js";

/**
 * The deadlines of a flow's question steps (#941): every `.toQuestion(Q, { expiresIn })` of every
 * path and sub-path (the side path `toQuestion(Q, …)` of an `.onError` too). One class is one node,
 * so one question has one `expiresIn` (`[question.expires-in-conflict]` otherwise); a value that is
 * no duration of at least `seconds(1)` is `[channel.expires-in-invalid]`.
 */

/** Each question class with the `expiresIn` its mentions name (`undefined` for a mention without one). */
export type QuestionExpiries = ReadonlyMap<Class, readonly (Milliseconds | undefined)[]>;

function collect(steps: readonly Step[], found: Map<Class, (Milliseconds | undefined)[]>): void {
  for (const step of steps) {
    if (step.kind === StepKind.Launch) continue;
    if (step.kind === StepKind.To) {
      if (step.targetKind !== NodeKind.Question) continue;
      found.set(step.target, [...(found.get(step.target) ?? []), step.expiresIn]);
      continue;
    }
    for (const path of subPathsOf(step)) collect(path.steps, found);
  }
}

/** The question mentions of a flow, in path order. */
export function questionExpiriesOf(flow: readonly FlowPath[]): QuestionExpiries {
  const found = new Map<Class, (Milliseconds | undefined)[]>();
  for (const path of flow) collect(path.steps, found);
  return found;
}

/** The one `expiresIn` of a question node: the first its mentions name; `undefined` → its role's. */
export const expiresInOfQuestion = (
  expiries: QuestionExpiries,
  question: Class,
): Milliseconds | undefined => expiries.get(question)?.find((value) => value !== undefined);

const nodeOf = (context: AnalysisContext, question: Class): FlowNode | undefined =>
  [...context.graph.nodes.values()].find((node) => node.component === question);

function problemsOf(
  node: FlowNode,
  listed: readonly (Milliseconds | undefined)[],
): RuleViolation[] {
  const invalid = listed.flatMap((value) =>
    value === undefined || isExpiresIn(value)
      ? []
      : [
          violation(
            "channel.expires-in-invalid",
            `${node.name}: expiresIn is ${String(value)} — a deadline is a positive finite duration of at least seconds(1), like hours(4)`,
            [node.name],
          ),
        ],
  );
  if (new Set(listed).size < 2) return invalid;
  const message =
    `${node.name} is asked with different expiresIn — one question is one node, so give every ` +
    "mention the same { expiresIn } (or none, and set it on the role)";
  return [...invalid, violation("question.expires-in-conflict", message, [node.name])];
}

/** `[channel.expires-in-invalid]` and `[question.expires-in-conflict]` over a workflow's question steps. */
export function questionExpiryRules(context: AnalysisContext): readonly RuleViolation[] {
  return [...questionExpiriesOf(context.workflow.flow)].flatMap(([question, listed]) => {
    const node = nodeOf(context, question);
    return node === undefined ? [] : problemsOf(node, listed);
  });
}
