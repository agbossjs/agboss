import type { AppDeps } from "../../app/app-deps.js";
import { ComponentKind, type ComponentRecord } from "../../flow/runtime/records.js";
import { verdictOfJudge } from "../../judges/declarative-judge.js";
import {
  isCodeJudge,
  type AnyJudgeInput,
  type JudgeRecord,
  type JudgeVerdict,
  type RunnableJudge,
} from "../../components/judge-decorators.js";
import { checkedJudgeOf, loadedCriterionOf } from "../../components/judge-parts.js";
import type { DtoClass } from "../../dto/types.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { NodeKind } from "../../flow/ast.js";
import { plainOutputClassOf } from "../../flow/finish-output.js";
import { isJudgedBy, judgedShapeOf } from "../../flow/analyse/rules/text-agents.js";
import { runInFrame } from "../../flow/context/frame.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import { meteredModel } from "../../graph/agent-loop/judge-model.js";
import { DEFAULT_MODEL_ALIAS } from "../../models/model-cascade.js";
import { modelProviderOf } from "../../models/model-provider.decorator.js";
import type { Class } from "../../components/injection.js";
import { judgeBindingOf, type JudgeBinding } from "../../llm/registry.js";
import { ModelKind } from "../../models/model-kind.js";
import type { EvalModelUse } from "./ran-on.js";
import { CheckStatus } from "../suite/checks.js";

import { judgeFrameOf, type JudgedExecution } from "./case-frame.js";
import { EvalCheckKind, type EvalCheckResult } from "./report.js";

/**
 * A `@Judge` at run time (#396 PR 2): the judge on the output of the finish the case's last
 * turn ended at, as its DTO — created by the application's container (its services, the execution
 * through `ExecutionContext` / `TenantContext`), run in the frame of that execution. A model judge's
 * calls go through the application's models, recorded as the run's `judgeUsd` and not billed to
 * the application's budgets. A run that ended at no finish, or at one whose output the judge does
 * not judge, fails the check (S5).
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
  return declaration?.kind === NodeKind.Finish
    ? plainOutputClassOf(declaration.options.output)
    : undefined;
}

/** Why a judge cannot judge the run's output; undefined = it can, as this class. */
function notJudged(meta: JudgeRecord, output: DtoClass | undefined, finish: string | undefined) {
  if (finish === undefined) return "the run ended at no finish";
  const { classes } = judgedShapeOf(meta.output);
  if (output !== undefined && classes.some((judged) => isJudgedBy(output, judged)))
    return undefined;
  return `the run ended at ${finish}, whose output ${meta.name} does not judge`;
}

/**
 * The judge's own model, bound for the eval and pinned: the judge's `modelProvider`, else the
 * suite's, else the application's — never the candidate workflow's own binding of a judge, so a
 * candidate does not grade itself.
 */
function bindingOf(
  deps: AppDeps,
  meta: JudgeRecord,
  suiteProvider: Class | undefined,
): JudgeBinding | undefined {
  if (isCodeJudge(meta)) return undefined;
  const provider = meta.modelProvider ?? suiteProvider;
  const { gateway } = deps.evaluation;
  if (gateway === undefined) throw new Error(`${meta.name}: the application has no models`);
  return judgeBindingOf(
    meta.name,
    {
      model: meta.model ?? DEFAULT_MODEL_ALIAS,
      ...(provider === undefined ? {} : { modelProvider: modelProviderOf(provider).name }),
    },
    deps.config,
    gateway,
  );
}

const verdictResult = (
  name: string,
  verdict: JudgeVerdict,
  spent: readonly UsageRecord[],
): EvalCheckResult => ({
  check: name,
  kind: EvalCheckKind.Judge,
  status: verdict.passed ? CheckStatus.Passed : CheckStatus.Failed,
  ...(verdict.passed ? {} : { reason: verdict.reason }),
  ...(verdict.metrics === undefined ? {} : { metrics: verdict.metrics }),
  ...(spent.length === 0 ? {} : { spentUsd: totalCost(spent) }),
});

/** Runs one judge check on a case's last turn. */
export async function runJudgeCheck(
  deps: AppDeps,
  judge: Class<object>,
  turn: JudgedTurn,
  suiteProvider?: Class,
): Promise<EvalCheckResult> {
  const { meta } = checkedJudgeOf(`eval judge`, judge);
  const output = turn.finish === undefined ? undefined : finishOutputOf(deps, turn.finish.name);
  const why = notJudged(meta, output, turn.finish?.name);
  if (why !== undefined || output === undefined)
    return {
      check: meta.name,
      kind: EvalCheckKind.Judge,
      status: CheckStatus.Failed,
      reason: why ?? "no output",
    };
  const spent: UsageRecord[] = [];
  const binding = bindingOf(deps, meta, suiteProvider);
  // a judge's calls are the yardstick's, not the candidate's: recorded as `judgeUsd`, never billed
  // to the application's budgets (#1328)
  const model = meteredModel({ name: meta.name, binding }, spent);
  const handler = deps.container.get(judge) as RunnableJudge;
  const declared = await loadedCriterionOf(meta);
  const input: AnyJudgeInput = {
    variant: output,
    output: turn.output,
    task: turn.task,
    attempt: 0,
    toolCalls: turn.toolCalls,
    files: [],
  };
  const frame = judgeFrameOf(deps, turn, { type: judge, name: meta.name });
  try {
    const verdict = await runInFrame(frame, () =>
      verdictOfJudge({ name: meta.name, handler, declared, binding }, input, model),
    );
    return verdictResult(meta.name, verdict, spent);
  } catch (error) {
    const reason = `${meta.name} threw: ${error instanceof Error ? error.message : String(error)}`;
    return { check: meta.name, kind: EvalCheckKind.Judge, status: CheckStatus.Failed, reason };
  }
}

/**
 * The model a model judge of the suite runs on, as the report's `judges` says (a code judge has
 * none): the judge's pinned provider, else the suite's, else the application's default (`default`).
 */
export function judgeUseOf(
  deps: AppDeps,
  judge: Class<object>,
  suiteProvider: Class | undefined,
): EvalModelUse | undefined {
  const { meta } = checkedJudgeOf(`eval judge`, judge);
  const binding = bindingOf(deps, meta, suiteProvider);
  if (binding === undefined) return undefined;
  const pinned = meta.modelProvider ?? suiteProvider;
  const provider =
    pinned === undefined
      ? binding.kind === ModelKind.Chat
        ? (binding.chat.settings.modelProvider ?? "default")
        : "default"
      : modelProviderOf(pinned).name;
  return { component: meta.name, kind: ComponentKind.Judge, model: binding.model, provider };
}
