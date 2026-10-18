import {
  meterOf,
  openBudgets,
  type BudgetMeter,
  type ExecutionBudgetRecord,
} from "../budgets/execution-budgets.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import { runInFrame, type FrameSpec } from "../flow/context/frame.js";
import { idempotencyKeyOf } from "../flow/context/idempotency.js";
import { standaloneContexts, tenantOfExecution } from "../flow/context/runtime-contexts.js";
import type { UsageRecord } from "../finops/usage.js";
import { executionGraphOf, type ExecutionGraph } from "../flow/runtime/build.js";
import { InMemoryCostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import type { RunDeps } from "./types.js";

/**
 * An execution's budgets in the run layer (#261 PR 5): opened once for a new execution — every
 * `maxSpend()` read in the frame of its start, so a budget reads the execution's `ExecutionContext`
 * (its tenant, its own fields) —, met again from its state on each later pass (a resume, a
 * recovery), and each call's cost recorded into their counters as the execution streams.
 */

/** What a new execution is before its first step: its ids, start, owner, signal and context values. */
export interface ExecutionStart {
  readonly executionId: string;
  readonly threadId: string;
  readonly start: string;
  readonly ownerId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly contexts: ExecutionContextValues;
}

/** The frame of an execution's start: what an injected `ExecutionContext` reads in `maxSpend()`. */
function startFrameOf<TName extends string>(
  deps: RunDeps<TName>,
  start: ExecutionStart,
): FrameSpec {
  const node = deps.graph.nodes.get(start.start);
  const { executionId } = start;
  const workflow = {
    type: deps.graph.type,
    name: deps.config.name,
    version: deps.config.version,
    startedVersion: deps.config.version,
  };
  const contexts = deps.contexts ?? standaloneContexts(workflow);
  return {
    execution: Object.freeze({
      executionId,
      threadId: start.threadId,
      ownerId: start.ownerId,
      signal: start.signal ?? new AbortController().signal,
      workflow: Object.freeze(workflow),
      tenant: tenantOfExecution(contexts, start.contexts.tenant),
      values: start.contexts.execution,
    }),
    step: Object.freeze({
      component: Object.freeze({ type: node?.component ?? deps.graph.type, name: start.start }),
      nodeId: start.start,
      visitNumber: 1,
      idempotencyKey: idempotencyKeyOf({ executionId, nodeId: start.start, visitNumber: 1 }),
      callId: undefined,
      itemIndex: undefined,
      copyNumber: 1,
    }),
  };
}

/** The budgets of a pass: what it is checked against, and their records (kept in its state). */
export interface PassBudgets {
  readonly meter: BudgetMeter;
  readonly records: readonly ExecutionBudgetRecord[];
}

/** No application, no budgets: a pass checked against nothing. */
const unbudgeted = (): PassBudgets => ({
  meter: meterOf({ ledger: new InMemoryCostLedgerRepository(), clock: () => new Date() }, [], 0),
  records: [],
});

/**
 * The budgets of a new execution, before its first step: each `maxSpend()` once, the counters
 * read — one exhausted throws `BudgetExceededError` (the execution is rejected).
 */
export async function openExecutionBudgets<TName extends string>(
  deps: RunDeps<TName>,
  start: ExecutionStart,
): Promise<PassBudgets> {
  const application = deps.budgets;
  if (application === undefined) return unbudgeted();
  const frame = startFrameOf(deps, start);
  const keys = {
    applicationName: application.applicationName,
    tenantId: start.contexts.tenant.tenantId,
    executionId: start.executionId,
  };
  const records = await openBudgets(application, deps.graph.type, keys, (work) =>
    runInFrame(frame, work),
  );
  const meter = meterOf(application, records, 0);
  await meter.refresh();
  return { meter, records };
}

/**
 * The budgets of a later pass of an execution (a resume, a recovery): the records it keeps in its
 * state (the amounts read at its start), `spentBefore` — what it spent before, already counted.
 */
export async function continuedExecutionBudgets<TName extends string>(
  deps: RunDeps<TName>,
  records: readonly ExecutionBudgetRecord[] | undefined,
  spentBefore: number,
): Promise<PassBudgets> {
  const application = deps.budgets;
  if (application === undefined) return unbudgeted();
  const kept = records ?? [];
  const meter = meterOf(application, kept, spentBefore);
  await meter.refresh();
  return { meter, records: kept };
}

/** Writes spend to the budgets' counters as it happens; remembers it for the Tern. */
export function recorder(
  meter: BudgetMeter,
  spent: UsageRecord[],
): (records: readonly UsageRecord[]) => Promise<void> {
  return async (records) => {
    spent.push(...records);
    await meter.record(records);
  };
}

/** The workflow's graph to read an execution's checkpoint with (no pass moves on it). */
export const readingGraphOf = <TName extends string>(deps: RunDeps<TName>): ExecutionGraph =>
  executionGraphOf(deps, { budgets: unbudgeted().meter });
