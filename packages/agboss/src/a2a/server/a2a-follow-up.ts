import type { Message } from "@a2a-js/sdk";
import { DurableExecutionStatus } from "../../app/execution-control.js";
import type { ResumeRequest } from "../../app/types.js";
import {
  isTerminalA2ATaskState,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskRecord,
} from "../../infrastructure/a2a-task.repository.js";
import {
  isKeptReply,
  PAUSE_CLOSED,
  refusalOf,
  settledOutcome,
  type KeptReply,
} from "./a2a-follow-up-outcome.js";
import {
  answerOfMessage,
  checkedCallerKey,
  requestHashOf,
  type FollowUpAnswer,
} from "./a2a-message-input.js";
import {
  logSubjectOf,
  ownedTask,
  repairedOf,
  taskKeyOf,
  type A2ARequestCaller,
  type A2AServerParts,
} from "./a2a-server-parts.js";
import { invalidParams, taskNotFound } from "./a2a-wire-errors.js";

/**
 * A follow-up message — one naming its `taskId` — answers one of the task's pauses (#808, design
 * §4.1.4): the caller's task (another's is "not found"), its message deduplicated like a new one, its
 * pause the one it names or the only one waiting — one of this task's pending pauses, else `-32602`
 * (never a pause of another task) —, then `app.resume` as the caller, detached from the request. The
 * pause's atomic `Pending → Resolved` decides a race with a cancel or another answer: the one that
 * loses is `-32004` and changes nothing. A reply
 * its interpreter cannot read is `-32602`, the pause still pending. A resend of the message replays
 * its outcome.
 */

/** The pauses of the task a caller may answer now, from its records. */
async function answerablePausesOf(
  parts: A2AServerParts,
  task: A2ATaskRecord,
): Promise<readonly string[]> {
  const tree = { tenantId: task.tenantId, rootExecutionId: task.taskId, threadId: task.contextId };
  const state = await parts.control.executionStateOf(tree);
  if (state.status !== DurableExecutionStatus.Paused) return [];
  return state.pending.flatMap(({ pauseId }) => (pauseId === undefined ? [] : [pauseId]));
}

/** The pause the answer is for: the one it names, else the only one waiting. */
function pauseOf(answer: FollowUpAnswer, pending: readonly string[]): string | KeptReply {
  if (pending.length === 0) return { refused: "unsupported", code: "a2a.no-pending-pause" };
  if (answer.pauseId !== undefined)
    return pending.includes(answer.pauseId)
      ? answer.pauseId
      : { refused: "invalid-params", code: "a2a.unknown-pause" };
  const [only] = pending;
  return pending.length === 1 &&
    // Stryker disable next-line ConditionalExpression: of one pending pause id, the first is defined
    only !== undefined
    ? only
    : { refused: "invalid-params", code: "a2a.pause-required" };
}

/**
 * Runs the resume here, detached from the request, and its outcome once it settles: refused when it
 * threw before its pause took the answer (a cancel or another answer won the pause's atomic
 * transition: `NotPausedError`), else accepted — whatever the run did after is its task's status.
 * Only the resume itself knows whether its answer was the one taken, so the outcome waits for it:
 * a follow-up is answered at its execution's next rest.
 */
async function resumed(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  task: A2ATaskRecord,
  request: ResumeRequest,
): Promise<KeptReply> {
  const key = taskKeyOf(task);
  let failure: { readonly error: unknown } | undefined;
  await parts.runs.start(key, async (onStream) => {
    try {
      return await parts.app.resume(request, {
        tenantId: caller.tenantId,
        ownerId: caller.ownerId,
        onStream,
      });
    } catch (error) {
      failure = { error };
      throw error;
    }
  });
  const isStillPending = (await answerablePausesOf(parts, task)).includes(request.pauseId);
  return settledOutcome(parts, key, failure, isStillPending);
}

/** A follow-up's answer, and the version its task had when the answer was taken. */
export interface FollowedUp {
  readonly task: A2ATaskRecord;
  /** The wait it answered, which is no rest any more (`isAtRest`). */
  readonly answered: number;
}

/** A kept outcome as replayed: its refusal thrown, its acceptance answered. */
function replayOf(task: A2ATaskRecord, reply: KeptReply): FollowedUp {
  if ("refused" in reply) throw refusalOf(reply);
  return { task, answered: reply.answered ?? task.version };
}

/**
 * A resend of a follow-up: its kept outcome replayed. With none kept yet — the first one still
 * decided here (awaited, then read again), or lost (a crash, a store error before it was kept) —
 * `undefined`: the answer is decided again, the pause's atomic transition deciding, so a lost
 * outcome is never reported as an acceptance.
 */
async function replayed(
  parts: A2AServerParts,
  task: A2ATaskRecord,
  kept: A2AMessageRecord,
  requestHash: string,
): Promise<FollowedUp | undefined> {
  if (kept.taskId !== task.taskId || kept.requestHash !== requestHash)
    throw invalidParams("a2a.message-id-reused", "messageId reused with different content");
  if (isKeptReply(kept.reply)) return replayOf(task, kept.reply);
  if (kept.reply !== undefined)
    parts.log.warn(
      "a2a.follow-up-reply-unread",
      `a kept reply of task ${task.taskId} is unreadable: decided again`,
      logSubjectOf(taskKeyOf(task)),
    );
  const running = parts.runs.settledOf(taskKeyOf(task));
  if (running === undefined) return undefined;
  await running;
  const again = await parts.tasks.findByMessage(kept);
  if (!isKeptReply(again?.reply)) return undefined;
  // #811: the task as it is after the wait, never as read before it — the run awaited moved it
  const read = await parts.tasks.findById(taskKeyOf(task));
  if (read === undefined) throw taskNotFound();
  return replayOf(await repairedOf(parts, read), again.reply);
}

/** The caller's task a follow-up names, checked against its context. */
async function followedTask(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  message: Message,
): Promise<A2ATaskRecord> {
  const task = await ownedTask(parts, caller, message.taskId);
  if (message.contextId !== "" && message.contextId !== task.contextId)
    throw invalidParams("a2a.context-mismatch", "the contextId is not the task's");
  return task;
}

/** The task a follow-up answers, its answer accepted (or a resend's kept outcome replayed). */
export async function followedUpTask(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  message: Message,
): Promise<FollowedUp> {
  const task = await followedTask(parts, caller, message);
  const answer = answerOfMessage(message);
  const key: A2AMessageKey = {
    tenantId: caller.tenantId,
    ownerId: caller.ownerId,
    messageId: checkedCallerKey("messageId", message.messageId),
  };
  const requestHash = requestHashOf(task.skill, message);
  const record = { ...key, requestHash, taskId: task.taskId, savedAt: parts.clock.now() };
  const kept = await parts.tasks.saveMessageIfAbsent(record);
  const replay = kept === undefined ? undefined : await replayed(parts, task, kept, requestHash);
  if (replay !== undefined) return replay;
  const decided = await answered(parts, caller, task, answer);
  const outcome: KeptReply =
    "accepted" in decided ? { accepted: true, answered: task.version } : decided;
  // a resend whose first outcome was lost, its pause gone since: the task as it is — neither an
  // acceptance nor a refusal it cannot know is true, and nothing kept for it
  const isLostReplay = kept !== undefined && isNoLongerWaiting(outcome);
  if (!isLostReplay) await parts.tasks.saveReplyIfAbsent(key, outcome);
  if ("refused" in outcome && !isLostReplay) throw refusalOf(outcome);
  const read = await parts.tasks.findById(taskKeyOf(task));
  if (read === undefined) throw taskNotFound();
  const after = await repairedOf(parts, read);
  return { task: after, answered: task.version };
}

/**
 * Whether an outcome says the task waited for no answer when it was decided (a kept reply of before,
 * `a2a.already-answered`, is replayed, never decided again).
 */
const isNoLongerWaiting = (outcome: KeptReply): boolean =>
  "refused" in outcome &&
  (outcome.code === "a2a.no-pending-pause" || outcome.code === PAUSE_CLOSED);

/** The answer's outcome: refused before anything moved, or the resume accepted. */
async function answered(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  task: A2ATaskRecord,
  answer: FollowUpAnswer,
): Promise<KeptReply> {
  if (isTerminalA2ATaskState(task.status.state))
    return { refused: "unsupported", code: "a2a.task-over" };
  const pauseId = pauseOf(answer, await answerablePausesOf(parts, task));
  if (typeof pauseId !== "string") return pauseId;
  const request: ResumeRequest =
    "reply" in answer ? { pauseId, reply: answer.reply } : { pauseId, decision: answer.decision };
  return resumed(parts, caller, task, request);
}
