import type { PauseRecord, PauseTrailRecord } from "../../infrastructure/pause-record.js";
import { rootFactsOf, type FrameSpec } from "../context/frame.js";
import type { TimeSpan } from "../../units/working-time.js";
import type { PauseChannel, PauseTarget } from "./pause-channel.js";
import type { PauseQuestion } from "./pause.js";
import { plainRecordOf } from "./records.js";

/** The facts a pause's record is made from — where it was asked and how it was opened (#337): split from `pause-record-made.ts`. */

/** The first entry of a pause's chain of custody: it was opened, under this target, with this deadline. */
export const openedEntryOf = (
  target: PauseTarget,
  channel: PauseChannel | undefined,
  at: Date,
  expiresAt: string | undefined,
  assignees: readonly string[] | undefined,
): PauseTrailRecord => ({
  action: "opened",
  at: at.toISOString(),
  target: target.name,
  // an owner's pause with no channel is asked of nobody
  ...(channel === undefined ? {} : { channel: channel.name }),
  ...(assignees === undefined ? {} : { assignees }),
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

/** What the target's hooks said of a pause being opened: who it is for, and how long it waits. */
export interface OpeningHooks {
  readonly assignees?: readonly string[] | undefined;
  /** `resolveTimeout`'s answer, checked; `undefined`: the target's own `timeout`. */
  readonly timeout?: TimeSpan | undefined;
}

/** What the pause's record says of where and how it was asked: its frame's identity and its step. */
export function placeOf(
  frame: FrameSpec,
  question: PauseQuestion,
): Pick<
  PauseRecord,
  | "tenantId"
  | "threadId"
  | "rootExecutionId"
  | "executionId"
  | "workflow"
  | "stepKey"
  | "nodeId"
  | "visitNumber"
  | "itemIndex"
  | "copyNumber"
  | "component"
  | "toolLoopIteration"
  | "validationAttempts"
> {
  const { execution, step } = frame;
  return {
    tenantId: execution.tenant.tenantId,
    threadId: execution.threadId,
    // inside a child workflow (#263) the record belongs to the tree: its root, the child's own id
    rootExecutionId: rootFactsOf(execution).executionId,
    executionId: execution.executionId,
    workflow: execution.workflow.name,
    stepKey: step.idempotencyKey,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    // a per-item child's own index when its step has none (#263)
    itemIndex: step.itemIndex ?? execution.itemIndex,
    copyNumber: step.copyNumber,
    component: plainRecordOf(question.component ?? step.component),
    ...(step.toolLoopIteration === undefined ? {} : { toolLoopIteration: step.toolLoopIteration }),
    validationAttempts: step.validationAttempts,
  };
}
