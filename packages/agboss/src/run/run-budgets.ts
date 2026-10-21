import { nodeRecordIn, workflowIdentityOf } from "../flow/runtime/workflow-keys.js";
import {
  accountOf,
  budgetExceededErrorOf,
  budgetKeyOf,
  budgetsOfExecution,
  counterOf,
  meterOf,
  type ApplicationBudgets,
  type BudgetMeter,
  type ExecutionBudgetRecord,
  type ExecutionKeys,
} from "../budgets/execution-budgets.js";
import type { Class } from "../components/injection.js";
import { usd } from "../units/index.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import { runInFrame, type ExecutionFacts, type FrameSpec } from "../flow/context/frame.js";
import { ExecutionContextUnavailableError } from "../flow/context/errors.js";
import { idempotencyKeyOf } from "../flow/context/idempotency.js";
import { standaloneContexts, tenantOfExecution } from "../flow/context/runtime-contexts.js";
import type { UsageRecord } from "../finops/usage.js";
import { executionGraphOf, type ExecutionGraph } from "../flow/runtime/build.js";
import { InMemoryCostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import { systemClock } from "../infrastructure/clock.js";
import type { AgentExecutionDeps } from "./types.js";

/**
 * An execution's budgets in the run layer (#261 PR 5): opened once for a new execution — every
 * `maxSpend()` read in the frame of its start, so a budget reads the execution's `ExecutionContext`
 * (its tenant, its own fields) —, met again from its state on each later pass (a resume, a
 * recovery), and each call's cost recorded into their counters as the execution streams.
 */

/** What a new execution is before its first step: its ids, start, owner, signal and context values. */
export interface ExecutionStart {
  readonly executionId: string;
  /** The thread it continues; `undefined` for a new one — created only once its budgets pass. */
  readonly threadId?: string | undefined;
  readonly start: string;
  readonly ownerId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly contexts: ExecutionContextValues;
}

/**
 * The execution's thread while its budgets are read: the one it continues; a new thread does not
 * exist yet — it is created only once the budgets pass, so a refused request leaves no thread.
 */
function threadIdOf(start: ExecutionStart): string {
  if (start.threadId !== undefined) return start.threadId;
  throw new ExecutionContextUnavailableError(
    `the thread of execution ${start.executionId} was read in maxSpend(): it is a new thread, created only once the execution's budgets pass — read threadId in a step`,
  );
}

/** The frame of an execution's start: what an injected `ExecutionContext` reads in `maxSpend()`. */
function startFrameOf<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  start: ExecutionStart,
): FrameSpec {
  const node = deps.graph.nodes.get(start.start);
  const { executionId } = start;
  const identity = workflowIdentityOf(deps);
  const workflow = { ...identity, startedVersion: identity.version };
  const contexts = deps.contexts ?? standaloneContexts(workflow);
  return {
    execution: Object.freeze(
      Object.defineProperty(
        {
          executionId,
          ownerId: start.ownerId,
          signal: start.signal ?? new AbortController().signal,
          workflow: Object.freeze(workflow),
          tenant: tenantOfExecution(contexts, start.contexts.tenant),
          values: start.contexts.execution,
        },
        "threadId",
        { enumerable: true, get: (): string => threadIdOf(start) },
      ) as ExecutionFacts,
    ),
    step: Object.freeze({
      component: Object.freeze({
        type: node?.component ?? deps.graph.type,
        ...nodeRecordIn(deps, start.start),
      }),
      nodeId: start.start,
      visitNumber: 1,
      idempotencyKey: idempotencyKeyOf({ executionId, nodeId: start.start, visitNumber: 1 }),
      callId: undefined,
      itemIndex: undefined,
      copyNumber: 1,
      toolLoopIteration: undefined,
      validationAttempts: 0,
    }),
  };
}

/**
 * Opens the budgets of a new execution: `maxSpend()` of each read once (in `inFrame`, where the
 * execution's `ExecutionContext` can be read) and kept in the ledger as the last known limit, then
 * every counter read — one exhausted rejects the execution before its first step.
 */
async function openBudgets(
  application: ApplicationBudgets,
  workflow: Class,
  keys: ExecutionKeys,
  inFrame: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<readonly ExecutionBudgetRecord[]> {
  const records: ExecutionBudgetRecord[] = [];
  for (const { type, meta } of budgetsOfExecution(application.budgets, workflow)) {
    const handler = application.resolve(type);
    const maxSpend = await inFrame(() => Promise.resolve(handler.maxSpend()));
    const record: ExecutionBudgetRecord = {
      budget: { name: meta.name },
      scope: meta.scope,
      ...(meta.period === undefined ? {} : { period: meta.period }),
      key: budgetKeyOf(meta.scope, keys),
      maxSpend,
    };
    records.push(record);
  }
  const now = application.clock.now();
  for (const record of records) {
    const spent = await application.ledger.findSpentByCounter(counterOf(record, now));
    if (spent >= record.maxSpend) throw budgetExceededErrorOf(record, spent, [], 0, []);
  }
  // kept only once the execution is admitted: a refused request leaves no trace
  for (const record of records)
    await application.ledger.saveMaxSpend(accountOf(record), usd(record.maxSpend));
  return records;
}

/** The budgets of a pass: what it is checked against, and their records (kept in its state). */
export interface PassBudgets {
  readonly meter: BudgetMeter;
  readonly records: readonly ExecutionBudgetRecord[];
}

/** No application, no budgets: a pass checked against nothing. */
const unbudgeted = (): PassBudgets => ({
  meter: meterOf({ ledger: new InMemoryCostLedgerRepository(), clock: systemClock }, [], 0),
  records: [],
});

/**
 * The budgets of a new execution, before its first step: each `maxSpend()` once, the counters
 * read — one exhausted throws `BudgetExceededError` (the execution is rejected).
 */
export async function openExecutionBudgets<TName extends string>(
  deps: AgentExecutionDeps<TName>,
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
  deps: AgentExecutionDeps<TName>,
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
export const readingGraphOf = <TName extends string>(
  deps: AgentExecutionDeps<TName>,
): ExecutionGraph => executionGraphOf(deps, { budgets: unbudgeted().meter });
