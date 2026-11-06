import type { Message } from "@a2a-js/sdk";
import { executeUnchecked } from "../../app/execute-unchecked.js";
import { DurableExecutionStatus } from "../../app/execution-control.js";
import { DuplicateExecutionIdError } from "../../core/errors.js";
import { failedStatusOf } from "../tasks/task-status.js";
import { withReservedExecutionId } from "../../app/tree-control.js";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2ATaskRecord,
  type NewA2ATask,
} from "../../infrastructure/a2a-task.repository.js";
import {
  checkedCallerKey,
  inputOfMessage,
  requestHashOf,
  skillOfMessage,
} from "./a2a-message-input.js";
import {
  callerOptionsOf,
  endedUnstarted,
  taskKeyOf,
  type A2ARequestCaller,
  type A2AServerParts,
} from "./a2a-server-parts.js";
import type { ServedSkill } from "./a2a-skills.js";
import { A2AInternalError, invalidParams, taskNotFound } from "./a2a-wire-errors.js";

/**
 * A new task (#808, design §4.1.3 and §4.3.1): the message's skill and input checked first —
 * nothing is kept for a message refused —, then the task accepted with the message, atomically,
 * under a task id minted for it (`saveIfAbsent`, unique by tenant, caller and `messageId`), then its
 * execution started under that reserved id, detached from the request. A message sent again with
 * the same id and the same content finds the task it was accepted for, never a second one — and,
 * while that task has not started (its first accept crashed before the start), starts it under the
 * same reserved id: the lease store keeps every execution id once, so one task starts at most one
 * execution, whichever instance tries. The same id with other content is `-32602`.
 */

/** How many minted task ids are tried before the generator is taken as broken. */
const MINT_ATTEMPTS = 3;

/** What one new message asks: its skill, its input and its hash. */
interface NewMessage {
  readonly message: Message;
  readonly skill: ServedSkill;
  readonly input: unknown;
  readonly requestHash: string;
}

/** Starts the task's execution under its reserved id, here, detached from the request. */
function started(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  task: A2ATaskRecord,
  sent: NewMessage,
): void {
  // it runs here already (a resend while it starts): one run is enough to ask for
  if (parts.runs.settledOf(taskKeyOf(task)) !== undefined) return;
  const { tenant, ownerId, execution } = callerOptionsOf(caller);
  const options = withReservedExecutionId(
    {
      threadId: task.contextId,
      ...(tenant === undefined ? {} : { tenant }),
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(execution === undefined ? {} : { execution }),
      ...(parts.maxTaskDuration === undefined ? {} : { deadline: parts.maxTaskDuration }),
    },
    task.taskId,
  );
  // its end is its task's status: the projection writes it, or — refused before it began — below
  void parts.runs.start(taskKeyOf(task), async (onStream) => {
    try {
      return await executeUnchecked(parts.app, sent.skill.start, sent.input, {
        ...options,
        onStream,
      });
    } catch (error) {
      await refusedStart(parts, task, error);
      throw error;
    }
  });
}

/**
 * A start the app refused before its execution began (another owner's context, invalid context
 * values, an exhausted budget): no execution will ever run under the task's id — it is fenced now,
 * in case the refusal came before the id was kept — so the task ends `FAILED` with the refusal's
 * code at once, not at the start timeout. A duplicate start (another one runs it) and an execution
 * that began (its records end it) change nothing.
 */
async function refusedStart(
  parts: A2AServerParts,
  task: A2ATaskRecord,
  error: unknown,
): Promise<void> {
  if (error instanceof DuplicateExecutionIdError) return;
  const tree = { tenantId: task.tenantId, rootExecutionId: task.taskId, threadId: task.contextId };
  await parts.control.claimExecutionId({ executionId: task.taskId, tenantId: task.tenantId });
  const state = await parts.control.executionStateOf(tree);
  if (state.status !== DurableExecutionStatus.NotStarted) return;
  const refusal = error instanceof Error ? error : new A2AInternalError();
  await endedUnstarted(parts, task, failedStatusOf(refusal));
}

/** A message accepted before: its task, if the same content; `-32602` otherwise. */
async function acceptedBefore(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  kept: { readonly requestHash: string; readonly taskId: string },
  sent: NewMessage,
): Promise<A2ATaskRecord> {
  if (kept.requestHash !== sent.requestHash)
    throw invalidParams("a2a.message-id-reused", "messageId reused with different content");
  const task = await parts.tasks.findById({ tenantId: caller.tenantId, taskId: kept.taskId });
  // the message's task is gone (swept): it is no more
  if (task === undefined) throw taskNotFound();
  if (task.status.state === A2ATaskState.Submitted) started(parts, caller, task, sent);
  return task;
}

/** The task of a new message: accepted now (and started), or the one it was accepted for. */
export async function acceptedTask(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  message: Message,
): Promise<A2ATaskRecord> {
  const skill = skillOfMessage(message, parts.skills);
  const input = inputOfMessage(message, skill);
  const messageId = checkedCallerKey("messageId", message.messageId);
  const contextId =
    message.contextId === ""
      ? parts.ids.newThreadId()
      : checkedCallerKey("contextId", message.contextId);
  const sent: NewMessage = { message, skill, input, requestHash: requestHashOf(skill.id, message) };
  const key = { tenantId: caller.tenantId, ownerId: caller.ownerId, messageId };
  const kept = await parts.tasks.findByMessage(key);
  if (kept !== undefined) return acceptedBefore(parts, caller, kept, sent);
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const task: NewA2ATask = {
      ...key,
      // minted through the application's checked generator: a key's text
      taskId: parts.ids.newExecutionId(),
      contextId,
      skill: skill.id,
      status: { state: A2ATaskState.Submitted, pendingPauses: [] },
      acceptedAt: parts.clock.now(),
      requestHash: sent.requestHash,
      ...(caller.caller.peer === undefined ? {} : { callerPeer: caller.caller.peer }),
    };
    const save = await parts.tasks.saveIfAbsent(task);
    switch (save.status) {
      case A2ATaskSaveStatus.Saved:
        started(parts, caller, save.task, sent);
        return save.task;
      case A2ATaskSaveStatus.MessageTaken:
        return acceptedBefore(parts, caller, save.message, sent);
      case A2ATaskSaveStatus.TaskIdTaken:
        continue; // an id minted again: the next one
    }
  }
  throw new A2AInternalError();
}
