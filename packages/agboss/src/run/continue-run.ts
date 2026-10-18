import { reserveSpend } from "../finops/reservations.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import type { ExecutionGraph } from "../flow/runtime/build.js";
import { startLine } from "../flow/runtime/history.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import {
  failedOutcome,
  outcomeError,
  recordFailure,
  recorder,
  workflowAccount,
  type TernBase,
} from "./execute.js";
import { finishRun } from "./finish.js";
import { withMetadata } from "./run-services.js";
import { streamConfig } from "./stream-config.js";
import type { AgentExecutionOutput, RunDeps, RunOptions } from "./types.js";
import { runVersions } from "./versions.js";

/** What continuing an execution needs to know of it: its ids, record, start, budget and spend so far. */
export interface ContinuedRun {
  readonly runId: string;
  readonly threadId: string;
  /** Its record (a Tern), completed when this pass ends. */
  readonly ternId: string;
  readonly start: string;
  readonly startInput: unknown;
  readonly budgetUsd: number;
  /** What it spent before this pass, already in the ledger. */
  readonly spent: readonly UsageRecord[];
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/** Streams the pass, recording spend as it happens; returns the last state. */
export type ContinuedPass = (
  graph: ExecutionGraph,
  streaming: ReturnType<typeof streamConfig>,
  record: (records: readonly UsageRecord[]) => Promise<void>,
) => Promise<ExecutionStateType>;

export type ContinueOptions = Omit<RunOptions, "replayOf" | "account" | "runId">;

/**
 * One more pass of an execution that already ran (a resume with its decision, or recovery from
 * its last checkpoint, #265 S30): same run id, same record, its budget minus what it spent held
 * again while it moves. Spend recorded before is not recorded again; a failure completes the record.
 */
export async function continueRun<TName extends string>(
  graph: ExecutionGraph,
  run: ContinuedRun,
  deps: RunDeps<TName>,
  options: ContinueOptions,
  pass: ContinuedPass,
): Promise<AgentExecutionOutput> {
  const metadata = options.metadata ?? run.metadata;
  const spent: UsageRecord[] = [];
  const left = run.budgetUsd - totalCost(run.spent);
  const hold = await reserveSpend(deps.ledger, workflowAccount(deps), Math.max(0, left));
  const record = recorder(hold, spent);
  const base: TernBase = {
    runId: run.runId,
    threadId: run.threadId,
    bundle: deps.config.name,
    task: startLine(run.start, run.startInput),
    replayOf: null,
    ...runVersions(deps),
  };
  try {
    const identity = { threadId: run.threadId, runId: run.runId, input: run.startInput };
    const streaming = streamConfig(deps, identity, { ...options, metadata });
    const state = await pass(graph, streaming, record);
    const context = {
      deps,
      graph,
      base,
      runId: run.runId,
      budgetUsd: run.budgetUsd,
      record,
      recorded: Math.max(run.spent.length, state.usage.length),
      callbacks: streaming.callbacks,
    };
    const output = await finishRun(context, state, run.ternId);
    return withMetadata(output, metadata);
  } catch (error) {
    const cause = outcomeError(error, options.signal);
    throw await recordFailure(cause, () =>
      deps.terns.complete(run.ternId, failedOutcome(cause, [...run.spent, ...spent])),
    );
  } finally {
    hold.release();
  }
}
