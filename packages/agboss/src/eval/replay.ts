import { isPeriodBudgetExhausted } from "../graph/limits.js";
import { runAgent } from "../run/run-agent.js";
import type { RunDeps } from "../run/types.js";
import { requestOfStartLine } from "../flow/runtime/start-input.js";
import { BUDGET_EXHAUSTED, scoreTerns, type EvalDeps } from "./eval.js";

export interface ReplayReport {
  readonly promptVersion: string;
  readonly tasks: number;
  readonly replayed: number;
  readonly before: number | null;
  readonly after: number | null;
  readonly costUsd: number;
  readonly stoppedBy?: string;
}

/**
 * `npm run replay`: re-runs the tasks of an old prompt version with the current config (as new
 * threads, `replayOf` set), scores both sides and compares — within the application's budgets.
 */
export async function replay<TName extends string>(
  run: RunDeps<TName>,
  evaluation: EvalDeps,
  options: { readonly promptVersion: string; readonly limit: number },
): Promise<ReplayReport> {
  const bundle = run.config.name;
  const originals = await run.terns.byVersion(bundle, options.promptVersion, options.limit);
  const unscored = await run.terns.unscored(bundle, options.promptVersion, options.limit);
  const baseline = await scoreTerns(evaluation, unscored);
  const replayedIds: string[] = [];
  let costUsd = baseline.costUsd;
  let stoppedBy = baseline.stoppedBy;
  for (const original of originals) {
    if (stoppedBy !== undefined) break;
    const request = requestOfStartLine(original.task);
    if (request === undefined) continue;
    try {
      const result = await runAgent(request, run, { replayOf: original.id });
      replayedIds.push(result.ternId);
      costUsd += result.cost.totalUsd;
    } catch (error) {
      if (isPeriodBudgetExhausted(error)) stoppedBy = BUDGET_EXHAUSTED;
    }
  }
  const scoring = await scoreTerns(evaluation, await run.terns.byIds(replayedIds));
  return {
    promptVersion: options.promptVersion,
    tasks: originals.length,
    replayed: replayedIds.length,
    before: await run.terns.meanScore(originals.map((tern) => tern.id)),
    after: await run.terns.meanScore(replayedIds),
    costUsd: costUsd + scoring.costUsd,
    ...(stoppedBy === undefined ? {} : { stoppedBy: stoppedBy }),
  };
}
