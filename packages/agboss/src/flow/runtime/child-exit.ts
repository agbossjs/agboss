import { recordOfNode, type ComponentRecords } from "./workflow-keys.js";
import { isGraphInterrupt } from "@langchain/langgraph";
import { handedOverReason } from "../../app/handed-over.js";
import { errorRecordOf } from "../../core/error-record.js";
import { ExecutionCancelledError } from "../../core/errors.js";
import { buildCostReport, type UsageRecord } from "../../finops/usage.js";
import { BudgetExceededError, LimitExceededError } from "../../graph/limits.js";
import type { WorkflowRecord } from "../context/execution-context.js";
import { ChildExecutionFailedError } from "./child-errors.js";
import {
  ChildExecutionStatus,
  type EndedChildRecord,
  type ChildIdentityRecord,
  type ChildLaunchRecord,
} from "./child-records.js";
import type { ExecutionStateType } from "./state.js";
import { unrecordedSpendOf } from "./node-runner.js";

/**
 * How a child execution ends for its parent (#263 S25): at a finish, its output is the parent's
 * value; an uncaught error of its own — a step's failure, its `maxSteps`, a node's `maxVisits` — is
 * wrapped into `ChildExecutionFailedError`; a tree-wide limit (a budget) passes through as it is, the
 * child's spend added to it; a cancellation (the execution's, or the launch's FailFast abort) passes
 * through as `ExecutionCancelledError`. A pause and a hand-over are no end: they rise as they are.
 * Every end is a nested record for the parent's state.
 */

/** A child execution as its record and its events name it. */
export interface EndedChild {
  readonly identity: ChildIdentityRecord;
  /** Its level in the tree, from 1 at the root (#264). */
  readonly depth: number;
  readonly workflow: WorkflowRecord;
  readonly launchedBy: ChildLaunchRecord;
  readonly start: string;
  readonly input: unknown;
  /** The child workflow's component records (#268 S93): its start's and finishes'. */
  readonly records: ComponentRecords;
}

/** The child's own spend: what its state holds past what it inherited. */
export const ownUsageOf = (
  state: ExecutionStateType | undefined,
  identity: ChildIdentityRecord,
): readonly UsageRecord[] => state?.usage.slice(identity.inheritedUsage) ?? [];

/** The nested record of a child that ended. */
export function childRecordOf(
  child: EndedChild,
  state: ExecutionStateType | undefined,
  end: {
    readonly status: ChildExecutionStatus;
    readonly usage: readonly UsageRecord[];
    readonly error?: unknown;
  },
): EndedChildRecord {
  const { identity } = child;
  const isFinished = end.status === ChildExecutionStatus.Finished && state !== undefined;
  return {
    executionId: identity.executionId,
    parentExecutionId: identity.parentExecutionId,
    rootExecutionId: identity.rootExecutionId,
    workflow: child.workflow,
    ...(identity.itemIndex === undefined ? {} : { itemIndex: identity.itemIndex }),
    depth: child.depth,
    launchedBy: child.launchedBy,
    start: recordOfNode(child.records, child.start),
    input: child.input,
    status: end.status,
    ...(isFinished
      ? { finish: recordOfNode(child.records, state.finish), output: state.output }
      : {}),
    ...(end.error === undefined ? {} : { error: errorRecordOf(end.error) }),
    path: state?.path ?? [],
    spend: buildCostReport(end.usage),
    children: state?.children ?? [],
  };
}

/** How a child's failure reaches its parent: what is thrown, how it is recorded, its spend. */
export interface ChildFailure {
  readonly thrown: unknown;
  readonly status: ChildExecutionStatus;
  readonly usage: readonly UsageRecord[];
  /** Spend that no error carries: reported to the parent's step directly. */
  readonly reported: readonly UsageRecord[];
}

/** A budget's error with the child's spend so far added to what it carries. */
function withSpend(error: LimitExceededError, spent: readonly UsageRecord[]): LimitExceededError {
  const usage: readonly UsageRecord[] = [...spent, ...error.usage];
  // the same error, its spend completed: a tree-wide limit is never wrapped (S25)
  Object.defineProperty(error, "usage", { value: usage, enumerable: true });
  return error;
}

/** What a child that threw `error` gives its parent; a pause or a hand-over rises as it is. */
export function childFailureOf(
  error: unknown,
  child: EndedChild,
  spent: readonly UsageRecord[],
  signal: AbortSignal,
): ChildFailure {
  if (isGraphInterrupt(error)) throw error;
  const handedOver = handedOverReason(signal);
  if (handedOver !== undefined) throw handedOver;
  const usage = [...spent, ...unrecordedSpendOf(error)];
  if (signal.aborted || error instanceof ExecutionCancelledError) {
    const cancelled =
      error instanceof ExecutionCancelledError
        ? error
        : new ExecutionCancelledError(
            `child execution ${child.identity.executionId} was cancelled`,
          );
    return { thrown: cancelled, status: ChildExecutionStatus.Cancelled, usage, reported: usage };
  }
  if (error instanceof BudgetExceededError)
    return {
      thrown: withSpend(error, spent),
      status: ChildExecutionStatus.Failed,
      usage,
      reported: [],
    };
  const identity = { executionId: child.identity.executionId, workflow: child.workflow };
  const thrown = new ChildExecutionFailedError(identity, error, usage);
  return { thrown, status: ChildExecutionStatus.Failed, usage, reported: [] };
}
