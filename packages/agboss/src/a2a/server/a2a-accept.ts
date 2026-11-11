import type { Message } from "@a2a-js/sdk";
import { executeWithoutInputCheck } from "../../app/execute-without-input-check.js";
import { DurableExecutionStatus } from "../../app/execution-control.js";
import { DuplicateExecutionIdError } from "../../core/errors.js";
import { failedStatusOf, rejectedStatusOf } from "../tasks/task-status.js";
import type { MeshLimitError } from "../../mesh/mesh-errors.js";
import { withInboundMesh } from "../../mesh/inbound-mesh.js";
import { inboundMeshOfA2A } from "./a2a-mesh-admission.js";
import { withReservedExecutionId } from "../../app/tree-control.js";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2ATaskRecord,
  type NewA2ATask,
} from "../../infrastructure/a2a-task.repository.js";
import { checkedCallerKey, requestHashOf, skillOfMessage } from "./a2a-message-input.js";
import {
  callerOptionsOf,
  endedUnstarted,
  logSubjectOf,
  taskKeyOf,
  type A2ARequestCaller,
  type A2AServerParts,
} from "./a2a-server-parts.js";
import type { ServedSkill } from "./a2a-skills.js";
import { isFilePart } from "./a2a-message-files.js";
import { meshFieldsOf, meshLimitOf } from "./a2a-accept-mesh.js";
import { inputForOf, keptFiles, type StartInput } from "./a2a-start-input.js";
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
 *
 * The mesh (#810, design §4.1.7): a message whose envelope's chain already passed through this
 * skill, or is as long as the application's `maxMeshHops`, is accepted as a `REJECTED` task with the
 * limit's code and facts — nothing started, so a resend finds that answer; any other runs with the
 * envelope's chain (and, for a trusted caller, its budget and deadline: `caller-budget`, the
 * execution's deadline), and a trusted caller's task keeps the message's `bodyHash` for its report.
 */

/** How many minted task ids are tried before the generator is taken as broken. */
const MINT_ATTEMPTS = 3;

/** What one new message asks: its skill, its hash, and its input under a task's id (#859: its files). */
interface NewMessage {
  readonly message: Message;
  readonly skill: ServedSkill;
  readonly requestHash: string;
  /** The input, checked, with its files admitted for the task — and the files to keep before it. */
  readonly inputFor: (taskId: string) => Promise<StartInput>;
}

/** Starts the task's execution under its reserved id, here, detached from the request. */
function started(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  task: A2ATaskRecord,
  sent: { readonly skill: ServedSkill; readonly input: unknown },
): void {
  // it runs here already (a resend while it starts): one run is enough to ask for
  if (parts.runs.settledOf(taskKeyOf(task)) !== undefined) return;
  const { tenant, ownerId, execution } = callerOptionsOf(caller);
  const options = withReservedExecutionId(
    withInboundMesh(
      {
        threadId: task.contextId,
        ...(tenant === undefined ? {} : { tenant }),
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(execution === undefined ? {} : { execution }),
        ...(parts.maxTaskDuration === undefined ? {} : { deadline: parts.maxTaskDuration }),
      },
      inboundMeshOfA2A(caller.mesh),
    ),
    task.taskId,
  );
  // its end is its task's status: the projection writes it, or — refused before it began — below
  void parts.runs.start(taskKeyOf(task), async (onStream) => {
    try {
      return await executeWithoutInputCheck(parts.app, sent.skill.start, sent.input, {
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

/**
 * The task just saved, as the store has it now; one the store lost right after saving it is the
 * request failed (`-32603`), never the stale saved record answered as if nothing happened.
 */
async function currentTaskOf(parts: A2AServerParts, saved: A2ATaskRecord): Promise<A2ATaskRecord> {
  const current = await parts.tasks.findById(taskKeyOf(saved));
  if (current === undefined) {
    parts.log.warn(
      "a2a.task-vanished",
      `task ${saved.taskId} was saved and is gone: the request failed`,
      logSubjectOf(taskKeyOf(saved)),
    );
    throw new A2AInternalError();
  }
  return current;
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
  if (task.status.state === A2ATaskState.Submitted) {
    // it waits to start (its first accept stopped before): its input again, its files kept already
    const { input, toSave } = await sent.inputFor(task.taskId);
    await keptFiles(parts, toSave);
    started(parts, caller, task, { skill: sent.skill, input });
  }
  return task;
}

/** A new message with no task yet, and what its task is keyed and placed by. */
interface Unaccepted {
  readonly sent: NewMessage;
  readonly key: {
    readonly tenantId: string;
    readonly ownerId: string | undefined;
    readonly messageId: string;
  };
  readonly contextId: string;
  readonly limit: MeshLimitError | undefined;
}

/** The new task of one minted id, saved with its input files kept first; the save's outcome. */
async function savedUnder(parts: A2AServerParts, caller: A2ARequestCaller, unaccepted: Unaccepted) {
  const { sent, key, contextId, limit } = unaccepted;
  // minted through the application's checked generator: a key's text
  const taskId = parts.ids.newExecutionId();
  // a rejected task runs nothing: its files are neither fetched nor kept
  const start = limit === undefined ? await sent.inputFor(taskId) : undefined;
  await keptFiles(parts, start?.toSave ?? []);
  const task: NewA2ATask = {
    ...key,
    taskId,
    contextId,
    skill: sent.skill.id,
    status:
      limit === undefined
        ? { state: A2ATaskState.Submitted, pendingPauses: [] }
        : rejectedStatusOf(limit),
    acceptedAt: parts.clock.now(),
    requestHash: sent.requestHash,
    ...meshFieldsOf(caller),
  };
  return { save: await parts.tasks.saveIfAbsent(task), start };
}

/** The task of a message no task was found for: minted, saved and started — or found after all. */
async function minted(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  unaccepted: Unaccepted,
): Promise<A2ATaskRecord> {
  const { sent } = unaccepted;
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const { save, start } = await savedUnder(parts, caller, unaccepted);
    switch (save.status) {
      case A2ATaskSaveStatus.Saved:
        // a rejected task is over as accepted: nothing ever runs under its id
        if (start !== undefined)
          started(parts, caller, save.task, { skill: sent.skill, input: start.input });
        // #811 (s17): the task as it is now, never as it was saved — this pass may have been held
        // after the save while another instance settled it (a2a.start-lost): an answer of the
        // saved SUBMITTED would move a terminal task back for this caller
        return currentTaskOf(parts, save.task);
      case A2ATaskSaveStatus.MessageTaken:
        return acceptedBefore(parts, caller, save.message, sent);
      // Stryker disable next-line ConditionalExpression: the last case — falling out of the switch goes on to the next attempt, as `continue` does
      case A2ATaskSaveStatus.TaskIdTaken:
        continue; // an id minted again: the next one
    }
  }
  throw new A2AInternalError();
}

/** The task of a new message: accepted now (and started), or the one it was accepted for. */
export async function acceptedTask(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  message: Message,
): Promise<A2ATaskRecord> {
  const skill = skillOfMessage(message, parts.skills);
  const inputFor = inputForOf(parts, caller, message, skill);
  // #859: a message without files is checked before anything is read or kept, as before
  // Stryker disable next-line StringLiteral: no file, so no file id: any task id checks the same
  if (message.parts.every((part) => !isFilePart(part))) await inputFor("");
  const messageId = checkedCallerKey("messageId", message.messageId);
  const contextId =
    message.contextId === ""
      ? parts.ids.newThreadId()
      : checkedCallerKey("contextId", message.contextId);
  const sent: NewMessage = {
    message,
    skill,
    requestHash: requestHashOf(skill.id, message),
    inputFor,
  };
  const key = { tenantId: caller.tenantId, ownerId: caller.ownerId, messageId };
  const kept = await parts.tasks.findByMessage(key);
  if (kept !== undefined) return acceptedBefore(parts, caller, kept, sent);
  return minted(parts, caller, { sent, key, contextId, limit: meshLimitOf(parts, caller, skill) });
}
