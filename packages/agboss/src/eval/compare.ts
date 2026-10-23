import { systemClock } from "../infrastructure/clock.js";
import { recordApplicationSpend } from "../budgets/application-spend.js";
import { isPeriodBudgetExhausted } from "../graph/limits.js";
import { executeAgent } from "../run/run-agent.js";
import { requestOfTask } from "../flow/runtime/start-input.js";
import type { AgentExecutionDeps } from "../run/types.js";
import type { RouteRequest } from "../routers/index.js";
import { BUDGET_EXHAUSTED, judgeRequest, scoreOf, type EvalDeps } from "./eval.js";
import { FIRST_BETTER, PAIR_INSTRUCTIONS, SECOND_BETTER } from "./prompts.js";

/** One side of a comparison: a workflow with (or without) a profile, within the application's budgets. */
export interface ProfileRun {
  readonly name: string;
  readonly deps: AgentExecutionDeps<string>;
  readonly evaluation: EvalDeps;
}

/** What one profile did on the tasks. */
export interface ProfileOutcome {
  readonly name: string;
  readonly version: string;
  readonly answers: readonly (string | undefined)[];
  readonly scores: readonly (number | undefined)[];
  readonly costUsd: number;
  readonly latenciesMs: readonly number[];
  readonly failed: number;
  readonly stoppedBy?: string;
}

/** A pairwise verdict is a tie when the judge is less sure than this. */
export const TIE_BELOW = 0.6;

async function judged(evaluation: EvalDeps, request: RouteRequest) {
  const outcome = await evaluation.judge.route(request);
  if (outcome.usage !== undefined)
    await recordApplicationSpend(evaluation.budgets, [outcome.usage]);
  return outcome;
}

/** Runs every task as a first contact; scores each answer with the judge — until a tenant's or the application's budget is exhausted. */
export async function runProfile(
  run: ProfileRun,
  tasks: readonly string[],
  clock: () => number = () => systemClock.now().getTime(),
): Promise<ProfileOutcome> {
  const answers: (string | undefined)[] = [];
  const scores: (number | undefined)[] = [];
  const latenciesMs: number[] = [];
  let costUsd = 0;
  let failed = 0;
  for (const task of tasks) {
    const started = clock();
    try {
      const request = requestOfTask(run.deps.graph, task);
      const result = await executeAgent(request, run.deps);
      latenciesMs.push(clock() - started);
      costUsd += result.cost.totalUsd;
      const [tern] = await run.deps.terns.byIds([result.ternId]);
      answers.push(tern?.replyWith);
      scores.push(
        tern === undefined ? undefined : scoreOf(await judged(run.evaluation, judgeRequest(tern))),
      );
    } catch (error) {
      if (isPeriodBudgetExhausted(error)) {
        return {
          name: run.name,
          version: run.deps.config.version,
          answers,
          scores,
          costUsd,
          latenciesMs,
          failed,
          stoppedBy: BUDGET_EXHAUSTED,
        };
      }
      failed += 1;
      answers.push(undefined);
      scores.push(undefined);
    }
  }
  return {
    name: run.name,
    version: run.deps.config.version,
    answers,
    scores,
    costUsd,
    latenciesMs,
    failed,
  };
}

export interface PairwiseResult {
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /**
   * Tasks on which the judge picked the same position in both orders — answer 1 both times, or
   * answer 2 both times: its position bias, not a preference. Each is also a tie (#396 S2 Q10).
   */
  readonly positionFlips: number;
}

/** Which side the judge preferred in one order, or that it was not sure (a failure too). */
type Preference = "baseline" | "other" | "unsure";

async function preferenceOf(
  evaluation: EvalDeps,
  task: string,
  first: string,
  second: string,
  isOtherFirst: boolean,
): Promise<Preference> {
  const outcome = await judged(evaluation, {
    instructions: PAIR_INSTRUCTIONS,
    input: `Task:\n${task}\n\nAnswer 1:\n${first}\n\nAnswer 2:\n${second}`,
    options: [
      { name: "first", description: FIRST_BETTER },
      { name: "second", description: SECOND_BETTER },
    ],
  });
  if (outcome.kind !== "decided" || (outcome.decision.confidence ?? 1) < TIE_BELOW) return "unsure";
  return (outcome.decision.next === "first") === isOtherFirst ? "other" : "baseline";
}

/**
 * Per task: which of baseline / other answers better, judged in both orders — baseline first, then
 * other first (#396 S2 Q10: always both, so a position bias cannot win). Two sure verdicts that agree
 * are a win or a loss; anything else is a tie — an unsure verdict or a judge failure in either
 * order, or two verdicts for opposite sides, which is the judge following the position
 * (`positionFlips`). A missing answer is not compared.
 */
export async function pairwise(
  evaluation: EvalDeps,
  tasks: readonly string[],
  baseline: ProfileOutcome,
  other: ProfileOutcome,
): Promise<PairwiseResult> {
  const tally = { wins: 0, losses: 0, ties: 0, positionFlips: 0 };
  for (const [i, task] of tasks.entries()) {
    const a = baseline.answers[i];
    const b = other.answers[i];
    if (a === undefined || b === undefined) continue;
    const baselineFirst = await preferenceOf(evaluation, task, a, b, false);
    const otherFirst = await preferenceOf(evaluation, task, b, a, true);
    if (baselineFirst === otherFirst && baselineFirst !== "unsure") {
      if (baselineFirst === "other") tally.wins += 1;
      else tally.losses += 1;
    } else {
      tally.ties += 1;
      if (baselineFirst !== "unsure" && otherFirst !== "unsure") tally.positionFlips += 1;
    }
  }
  return tally;
}
