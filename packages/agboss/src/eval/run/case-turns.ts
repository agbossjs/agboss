import { type Usd, usd } from "../../units/index.js";
import { executeWithoutInputCheck } from "../../app/execute-without-input-check.js";
import { ExecutionStatus, type ExecutionOutput } from "../../app/types.js";
import { nameOf } from "../../components/name-of.js";
import { AGBossError } from "../../core/errors.js";
import { turnsOfCase, type EvalCase } from "../suite/cases.js";
import type { EvalPauseScript } from "../suite/pauses.js";
import type { CaseContextValues } from "./case-frame.js";
import type { SuiteRunParts } from "./case-run.js";
import type { EvalRunError } from "./report.js";

/**
 * The turns of one run of a case (#396 PR 2), in order on its thread through the application
 * (`app.execute`, the case's `tenant` / `execution` as validated) — the case's own, or a variant's
 * (`--metamorphic`, #396 PR 7): the same turns with the last one reworded. A turn that pauses is
 * answered by the pauses its script lists (`answerPause`, `replyToPause`, #1328d); the last turn
 * must end as the case's `expectedStatus` says (default `Finished`).
 */

/** How the turns of a run went: the last turn's output, or why one could not end. */
export type TurnsOutcome =
  | { readonly kind: "ended"; readonly last: ExecutionOutput; readonly spentUsd: Usd }
  | { readonly kind: "failed"; readonly error: EvalRunError; readonly spentUsd: Usd };

const errorOf = (error: unknown): EvalRunError =>
  error instanceof AGBossError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : String(error) };

/** Where a case's turns run, and who is asking. */
interface TurnsOf {
  readonly threadId: string;
  readonly values: CaseContextValues;
}

/** Answers the open pause of the script's target: its pending entry, resumed by decision or reply. */
async function answered(
  parts: SuiteRunParts,
  paused: ExecutionOutput,
  script: EvalPauseScript,
  thread: TurnsOf,
): Promise<ExecutionOutput> {
  const channel = nameOf(script.target);
  const pending = paused.pending.find((found) => found.channel === channel);
  if (pending?.pauseId === undefined)
    throw new PauseNotOpenError(
      `no open pause of ${channel} to answer: ${
        paused.pending.map((found) => found.channel).join(", ") || "none is pending"
      }`,
    );
  const caller = { tenantId: thread.values.tenant.tenantId, ownerId: script.actor?.id };
  const { pauseId } = pending;
  return script.reply === undefined
    ? parts.app.resume({ pauseId, decision: script.decision }, caller)
    : parts.app.resume({ pauseId, reply: script.reply }, caller);
}

/** A scripted answer with no pause of its target to take it: the case is wrong, not the run. */
class PauseNotOpenError extends Error {
  override readonly name = "PauseNotOpenError";
}

/** Runs one turn, then its scripted pauses in order; the output of the last resume, or of the turn. */
async function runTurn(
  parts: SuiteRunParts,
  options: {
    readonly input: unknown;
    readonly isLast: boolean;
    readonly script: readonly EvalPauseScript[];
  },
  context: { readonly thread: TurnsOf; readonly contexts: object },
): Promise<{ readonly outputs: readonly ExecutionOutput[]; readonly error?: EvalRunError }> {
  const { thread, contexts } = context;
  const outputs: ExecutionOutput[] = [];
  let last = await executeWithoutInputCheck(parts.app, parts.start.component, options.input, {
    threadId: thread.threadId,
    ...contexts,
    record: options.isLast, // the last turn's trajectory (#397 PR 2)
  });
  outputs.push(last);
  for (const script of options.script) {
    if (last.status !== ExecutionStatus.Paused) break;
    last = await answered(parts, last, script, thread);
    outputs.push(last);
  }
  return { outputs };
}

/** The values as validated; `execution` only where the case gives it (the built-in class has none). */
const contextsOf = (written: EvalCase, values: CaseContextValues) => ({
  tenant: values.tenant,
  ...(written.execution === undefined ? {} : { execution: values.execution }),
});

/**
 * A cancel or a stop of a turn (#1341) fails the case, unless it is the last turn and what the
 * case expects.
 */
function endFailureOf(
  last: ExecutionOutput,
  turn: { readonly index: number; readonly isLast: boolean; readonly expected: ExecutionStatus },
): EvalRunError | undefined {
  const isEnd =
    last.status === ExecutionStatus.Cancelled || last.status === ExecutionStatus.Stopped;
  if (!isEnd || (turn.isLast && turn.expected === last.status)) return undefined;
  return {
    code: `execution.${last.status}`,
    message: `turn ${String(turn.index)} was ${last.status}`,
  };
}

/** The turns in order on one thread; an earlier turn that pauses and is not answered stops the run. */
export async function runTurns(
  parts: SuiteRunParts,
  written: EvalCase,
  thread: TurnsOf,
): Promise<TurnsOutcome> {
  const contexts = contextsOf(written, thread.values);
  const turns = turnsOfCase(written);
  const expected = written.expectedStatus ?? ExecutionStatus.Finished;
  // a turn's cumulative spend is read once, after all its pauses resolved: never added twice
  let spentUsd: Usd = usd(0);
  let last: ExecutionOutput | undefined;
  for (const [index, turn] of turns.entries()) {
    if (last?.status === ExecutionStatus.Paused) {
      const message = `turn ${String(index)} paused: the turns after it cannot run`;
      return { kind: "failed", error: { code: "execution.paused", message }, spentUsd };
    }
    try {
      const isLast = index === turns.length - 1;
      const ran = await runTurn(
        parts,
        { input: turn.input, isLast, script: turn.pauses ?? [] },
        { thread, contexts },
      );
      last = ran.outputs.at(-1);
    } catch (error) {
      return { kind: "failed", error: errorOf(error), spentUsd };
    }
    if (last === undefined) throw new Error(`case "${written.name}" ran a turn with no output`);
    spentUsd = usd(spentUsd + last.spend.totalUsd);
    const failure = endFailureOf(last, { index, isLast: index === turns.length - 1, expected });
    if (failure !== undefined) return { kind: "failed", error: failure, spentUsd };
  }
  if (last === undefined) throw new Error(`case "${written.name}" has no turns`);
  return { kind: "ended", last, spentUsd };
}
