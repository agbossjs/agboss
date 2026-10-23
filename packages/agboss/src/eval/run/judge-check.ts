import type { AppDeps } from "../../app/app-deps.js";
import type { ComponentRecord } from "../../flow/runtime/records.js";
import { recordApplicationSpend } from "../../budgets/application-spend.js";
import { runJudgeCall } from "../../components/judge-call.js";
import {
  isCodeJudge,
  type AnyJudgeInput,
  type JudgeHandlerClass,
  type JudgeMeta,
  type JudgeVerdict,
  type RunnableJudge,
} from "../../components/judge-decorators.js";
import { checkedJudgeOf } from "../../components/judge-parts.js";
import type { DtoClass } from "../../dto/types.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { NodeKind } from "../../flow/ast.js";
import { isJudgedBy, judgedShapeOf } from "../../flow/analyse/rules/text-agents.js";
import { runInFrame } from "../../flow/context/frame.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import { meteredModel } from "../../graph/agent-loop/judge-model.js";
import { judgeBindingOf, type JudgeBinding } from "../../llm/registry.js";
import { CheckStatus } from "../suite/checks.js";
import { judgeFrameOf, type JudgedExecution } from "./case-frame.js";
import type { EvalCheckResult } from "./report.js";

/**
 * `judgedBy(Judge)` at run time (#396 PR 2): the judge on the output of the finish the case's last
 * turn ended at, as its DTO — created by the application's container (its services, the execution
 * through `ExecutionContext` / `TenantContext`), run in the frame of that execution. A model judge's
 * calls go through the application's models, counted in its application budgets. A run that ended
 * at no finish, or at one whose output the judge does not judge, fails the check (S5).
 */

/** The last turn as a judge reads it. */
export interface JudgedTurn extends JudgedExecution {
  readonly finish: ComponentRecord | undefined;
  readonly output: unknown;
  /** The last turn's start line (`start <name>: <input>`). */
  readonly task: string;
  readonly toolCalls: readonly ToolCallRecord[];
}

/** The output class of the finish a run ended at; undefined = not a finish of the workflow. */
function finishOutputOf(deps: AppDeps, finish: string): DtoClass | undefined {
  const declaration = deps.graph.nodes.get(finish)?.declaration;
  return declaration?.kind === NodeKind.Finish ? declaration.options.output : undefined;
}

/** Why a judge cannot judge the run's output; undefined = it can, as this class. */
function notJudged(meta: JudgeMeta, output: DtoClass | undefined, finish: string | undefined) {
  if (finish === undefined) return "the run ended at no finish";
  const { classes } = judgedShapeOf(meta.reply);
  if (output !== undefined && classes.some((reply) => isJudgedBy(output, reply))) return undefined;
  return `the run ended at ${finish}, whose output ${meta.name} does not judge`;
}

/** The judge's own model: an agent's binding when one lists it, else bound for the eval now. */
function bindingOf(deps: AppDeps, meta: JudgeMeta): JudgeBinding | undefined {
  if (isCodeJudge(meta)) return undefined;
  const known = deps.registry.judges.get(meta.name);
  if (known !== undefined) return known;
  const { gateway } = deps.evaluation;
  if (gateway === undefined) throw new Error(`${meta.name}: the application has no models`);
  return judgeBindingOf(meta.name, { model: meta.model }, deps.config, gateway);
}

const verdictResult = (
  name: string,
  verdict: JudgeVerdict,
  spent: readonly UsageRecord[],
): EvalCheckResult => ({
  check: name,
  status: verdict.passed ? CheckStatus.Passed : CheckStatus.Failed,
  ...(verdict.passed ? {} : { reason: verdict.reason }),
  ...(verdict.metrics === undefined ? {} : { metrics: verdict.metrics }),
  ...(spent.length === 0 ? {} : { spentUsd: totalCost(spent) }),
});

/** Runs one judge check on a case's last turn. */
export async function runJudgeCheck(
  deps: AppDeps,
  judge: JudgeHandlerClass,
  turn: JudgedTurn,
): Promise<EvalCheckResult> {
  const { meta } = checkedJudgeOf(`eval judge`, judge);
  const output = turn.finish === undefined ? undefined : finishOutputOf(deps, turn.finish.name);
  const why = notJudged(meta, output, turn.finish?.name);
  if (why !== undefined || output === undefined)
    return { check: meta.name, status: CheckStatus.Failed, reason: why ?? "no output" };
  const spent: UsageRecord[] = [];
  const model = meteredModel({ name: meta.name, binding: bindingOf(deps, meta) }, spent);
  const handler = deps.container.get(judge) as RunnableJudge;
  const input: AnyJudgeInput = {
    variant: output,
    reply: turn.output,
    task: turn.task,
    attempt: 0,
    toolCalls: turn.toolCalls,
  };
  const frame = judgeFrameOf(deps, turn, { type: judge, name: meta.name });
  try {
    const verdict = await runInFrame(frame, () => runJudgeCall(model, () => handler.judge(input)));
    return verdictResult(meta.name, verdict, spent);
  } catch (error) {
    const reason = `${meta.name} threw: ${error instanceof Error ? error.message : String(error)}`;
    return { check: meta.name, status: CheckStatus.Failed, reason };
  } finally {
    await recordApplicationSpend(deps.evaluation.budgets, spent);
  }
}
