import { recordOfNode, type ComponentRecords } from "./workflow-keys.js";
import { isGraphInterrupt } from "@langchain/langgraph";
import { handedOverOf, recordedHandOver } from "../../app/handed-over.js";
import { HandOverSite } from "../../infrastructure/execution-lease-event.repository.js";
import { errorRecordOf } from "../../core/error-record.js";
import { ExecutionCancelledError } from "../../core/errors.js";
import { buildCostReport, type UsageRecord } from "../../finops/usage.js";
import { BudgetExceededError, LimitExceededError } from "../../graph/limits.js";
import type { WorkflowRecord } from "../context/execution-context.js";
import { ChildExecutionFailedError } from "./child-errors.js";
import { CompensationFailedError } from "../compensation.js";
import {
  ChildExecutionStatus,
  type EndedChildRecord,
  type ChildIdentityRecord,
  type ChildLaunchRecord,
} from "./child-records.js";
import type { ExecutionStateType } from "./state.js";
import { carriedRecordsOf, type CarriedRecords } from "./carried-records.js";
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

/**
 * What a child's state holds of its own — its path, tool calls and steps (#395) and children — with
 * what its failure carries of the visit that failed (S6).
 */
const ownRecordsOf = (
  state: ExecutionStateType | undefined,
  carried: CarriedRecords | undefined,
): Pick<EndedChildRecord, "path" | "toolCalls" | "steps" | "children"> => {
  const failed = carried ?? carriedRecordsOf(undefined);
  if (state === undefined)
    return { path: [], toolCalls: [...failed.toolCalls], steps: [...failed.steps], children: [] };
  return {
    path: state.path,
    toolCalls: [...state.toolCalls, ...failed.toolCalls],
    steps: [...state.stepRecords, ...failed.steps],
    children: state.children,
  };
};

/** The nested record of a child that ended. */
export function childRecordOf(
  child: EndedChild,
  state: ExecutionStateType | undefined,
  end: {
    readonly status: ChildExecutionStatus;
    readonly usage: readonly UsageRecord[];
    readonly error?: unknown;
    /** What its failure carried of the visit that failed (#395 S6). */
    readonly carried?: CarriedRecords;
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
    spend: buildCostReport(end.usage),
    ...ownRecordsOf(state, end.carried),
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
  const handedOver = handedOverOf(error, signal);
  if (handedOver !== undefined) throw recordedHandOver(handedOver, HandOverSite.Child);
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
  // a failed automatic undo passes the boundary as it is: no side path takes it (#340 S5)
  if (error instanceof CompensationFailedError)
    return { thrown: error, status: ChildExecutionStatus.Failed, usage, reported: [] };
  const identity = { executionId: child.identity.executionId, workflow: child.workflow };
  const thrown = new ChildExecutionFailedError(identity, error, usage);
  return { thrown, status: ChildExecutionStatus.Failed, usage, reported: [] };
}
