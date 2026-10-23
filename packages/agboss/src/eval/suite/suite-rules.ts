import { checkedJudgeOf } from "../../components/judge-parts.js";
import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import { requireApplication } from "../../application/application.js";
import { startsOfApplication } from "../../application/application-starts.js";
import { NodeKind } from "../../flow/ast.js";
import { checkWorkflow } from "../../flow/analyse/analyse.js";
import { childWorkflowOf, withChildWorkflows } from "../../flow/analyse/child-workflow.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { reachableFrom } from "../../flow/analyse/flow-graph.js";
import { dtoLabel, shapeLabel } from "../../flow/analyse/labels.js";
import { isJudgedBy, judgedShapeOf } from "../../flow/analyse/rules/text-agents.js";
import { kindSuffixProblem, NameKind } from "../../flow/names.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { isJudgeCheck, type JudgeEvalCheck } from "./checks.js";
import type { EvalSuiteMeta } from "./eval-suite.decorator.js";

/**
 * The assembly rules of an `@EvalSuite` (#396), against the application it runs on: its `name`
 * ends with `-eval-suite` and its class with `EvalSuite` (`[name.kind-suffix]`), its start is a
 * start of the application (`[eval.unknown-start]`), every case name is unique
 * (`[eval.duplicate-case]`), every judge is a `@Judge` (`[judge.not-a-judge]`, its model rules) and
 * judges the output of a finish the start reaches (`[eval.judge-wrong-reply]`) — one value, never a
 * list; a run that ends at a finish its judge does not judge fails that check.
 */

const CLASS_SUFFIX = "EvalSuite";

/** A start's `name` (`refund-workflow-start`), its class name when it is not a start. */
function startNameOf(start: Class): string {
  const declaration = declarationOf(start);
  return declaration?.kind === NodeKind.Start ? declaration.options.name : start.name;
}

function nameViolations(suite: Class, meta: EvalSuiteMeta): RuleViolation[] {
  const found: RuleViolation[] = [];
  const problem = kindSuffixProblem(meta.name, NameKind.EvalSuite);
  if (problem !== undefined) found.push(violation(problem.code, problem.message, [meta.name]));
  const className = suite.name;
  if (className.length <= CLASS_SUFFIX.length || !className.endsWith(CLASS_SUFFIX))
    found.push(
      violation("name.kind-suffix", `class ${className} — name it ${className}${CLASS_SUFFIX}`, [
        meta.name,
      ]),
    );
  return found;
}

function duplicateCases(meta: EvalSuiteMeta): RuleViolation[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const { name } of meta.cases) (seen.has(name) ? twice : seen).add(name);
  return [...twice].map((name) =>
    violation(
      "eval.duplicate-case",
      `${meta.name}: two cases are named "${name}" — a case name is unique in its suite (it keys reports and baselines)`,
      [meta.name],
    ),
  );
}

/** The output classes of the finishes the start reaches, in the workflow it opens. */
function reachedOutputs(
  workflows: readonly Class[],
  start: Class,
): readonly DtoClass[] | undefined {
  for (const workflow of withChildWorkflows(workflows)) {
    const child = childWorkflowOf(workflow);
    const entry = child?.starts.find((found) => found.component === start);
    if (entry === undefined) continue;
    const { analysis } = checkWorkflow(workflow);
    if (analysis === undefined) return [];
    const { graph } = analysis;
    return [...reachableFrom([entry.name], graph.edges)].flatMap((name) => {
      const declaration = graph.nodes.get(name)?.declaration;
      return declaration?.kind === NodeKind.Finish ? [declaration.options.output] : [];
    });
  }
  return undefined;
}

function wrongReply(
  meta: EvalSuiteMeta,
  check: JudgeEvalCheck,
  outputs: readonly DtoClass[],
): RuleViolation[] {
  const judge = checkedJudgeOf(`@EvalSuite "${meta.name}"`, check.judge).meta;
  const replies = judgedShapeOf(judge.reply);
  const what = `${meta.name}: ${judge.name} judges ${shapeLabel(judge.reply)}, but the runs of ${startNameOf(meta.start)} end at finishes with ${outputs.map(dtoLabel).join(", ") || "no output"}`;
  if (replies.isList)
    return [
      violation(
        "eval.judge-wrong-reply",
        `${what} — an eval judge judges the finish's output, one value: set @Judge({ reply }) to it`,
        [judge.name],
      ),
    ];
  const judged = outputs.some((output) =>
    replies.classes.some((reply) => isJudgedBy(output, reply)),
  );
  if (judged) return [];
  const message = `${what} — it judges none of them: set @Judge({ reply }) to a finish's output (oneOf(…) for several)`;
  return [violation("eval.judge-wrong-reply", message, [judge.name])];
}

/** Every judge of the suite: its checks', then each case's, each class once. */
function judgesOf(meta: EvalSuiteMeta): readonly JudgeEvalCheck[] {
  const all = [...meta.checks.filter(isJudgeCheck), ...meta.cases.flatMap((c) => c.judges ?? [])];
  return [...new Map(all.map((check) => [check.judge, check])).values()];
}

/** Every rule violation of a suite on its application. */
export function evalSuiteViolations(
  application: Class,
  suite: Class,
  meta: EvalSuiteMeta,
): RuleViolation[] {
  const found = [...nameViolations(suite, meta), ...duplicateCases(meta)];
  const { options } = requireApplication(application, "checkEvalSuite");
  const outputs = reachedOutputs(options.workflows, meta.start);
  if (outputs === undefined) {
    const starts = startsOfApplication(application).map((start) => start.name);
    const message = `${meta.name}: ${startNameOf(meta.start)} is not a start of ${application.name} — its starts: ${starts.join(", ")}`;
    return [...found, violation("eval.unknown-start", message, [meta.name])];
  }
  return [...found, ...judgesOf(meta).flatMap((check) => wrongReply(meta, check, outputs))];
}
