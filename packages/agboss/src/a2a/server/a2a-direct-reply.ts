import type { Message } from "@a2a-js/sdk";
import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type A2ADirectMessageKey,
  type A2ADirectMessageRecord,
  type NewA2ADirectMessage,
} from "../../infrastructure/a2a-direct-message.repository.js";
import { settledLostAttempt } from "../../infrastructure/a2a-direct-message-expiry.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { meshFieldsOf, meshLimitOf } from "./a2a-accept-mesh.js";
import { IN_FLIGHT, ranAttempt } from "./a2a-direct-run.js";
import { wireReplyOf } from "./a2a-direct-view.js";
import { isFilePart } from "./a2a-message-files.js";
import { checkedCallerKey, requestHashOf } from "./a2a-message-input.js";
import type { A2ARequestCaller, A2AServerParts } from "./a2a-server-parts.js";
import type { ServedSkill } from "./a2a-skills.js";
import { inputForOf, keptFiles, type StartInput } from "./a2a-start-input.js";
import { A2AInternalError, invalidParams } from "./a2a-wire-errors.js";

/**
 * A message to a direct-reply skill (#860, design §4.1.8): answered with a `Message`, no task. Its
 * input is checked before anything is kept; then its `(tenant, owner, messageId)` is accepted
 * `InFlight` — atomically with its id's claim among the task store's messages — and the skill runs
 * once: a resend of a completed one gets the kept reply, a resend while it runs waits for it
 * (polling the store on the `Clock`, bounded by the attempt's `expiresAt` and the caller's
 * connection), a resend after the attempt was lost takes it over (one instance wins: the lost
 * attempt's Unknown cost is recorded once), and a failed one is not kept — a resend runs it again.
 * Another message under the id — other content, or a task's — is `-32602 a2a.message-id-reused`.
 */

/** How often a resend that waits reads the store again. */
const POLL_EVERY: Milliseconds = seconds(0.25);

/** How many rounds a message is read, saved or taken over before the request fails. */
const ROUNDS = 5;

const reused = () =>
  invalidParams("a2a.message-id-reused", "messageId reused with different content");

/** What one message asks, and how its input is read for an attempt. */
interface DirectMessage {
  readonly key: A2ADirectMessageKey;
  readonly skill: ServedSkill;
  readonly requestHash: string;
  readonly contextId: string;
  readonly inputFor: (attemptId: string) => Promise<StartInput>;
}

/** A new attempt: its id minted, its input read (its files kept under it), its bound. */
async function attemptOf(parts: A2AServerParts, sent: DirectMessage) {
  const attemptId = parts.ids.newExecutionId();
  const start = await sent.inputFor(attemptId);
  await keptFiles(parts, start.toSave);
  const startedAt = parts.clock.now();
  const expiresAt = new Date(startedAt.getTime() + IN_FLIGHT);
  return { attempt: { attemptId, startedAt, expiresAt }, input: start.input };
}

/** The attempt's files, when the store kept none of its row: removed at once. */
const droppedFiles = (parts: A2AServerParts, tenantId: string, attemptId: string) =>
  parts.files.store.deleteByOwner({ tenantId, ownerId: attemptId });

/** The reply of an attempt this call holds, kept; `undefined` when it was taken over meanwhile. */
async function ran(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  held: A2ADirectMessageRecord,
  sent: { readonly skill: ServedSkill; readonly input: unknown },
): Promise<A2ADirectMessageRecord | undefined> {
  const reply = await ranAttempt(parts, caller, held, sent);
  // taken over meanwhile (the run outlived its row): the next round reads it as the store has it
  return parts.direct.messages.completeIfInFlight(held, held.attemptId, reply, parts.clock.now());
}

/** A new message: saved and run, or the row another call saved first. */
async function saved(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  sent: DirectMessage,
): Promise<A2ADirectMessageRecord | undefined> {
  const { attempt, input } = await attemptOf(parts, sent);
  const message: NewA2ADirectMessage = {
    ...sent.key,
    ...attempt,
    requestHash: sent.requestHash,
    skill: sent.skill.id,
    contextId: sent.contextId,
    callsModel: sent.skill.callsModel,
    createdAt: attempt.startedAt,
    ...meshFieldsOf(caller),
  };
  const save = await parts.direct.messages.saveIfAbsent(message);
  if (save.status === A2ADirectMessageSaveStatus.Saved)
    return ran(parts, caller, save.message, { skill: sent.skill, input });
  await droppedFiles(parts, sent.key.tenantId, attempt.attemptId);
  if (save.status === A2ADirectMessageSaveStatus.Taken) throw reused();
  return save.message;
}

/** A lost attempt taken over by this call: settled, then run under a new one; else as it is now. */
async function retaken(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  lost: A2ADirectMessageRecord,
  sent: DirectMessage,
): Promise<A2ADirectMessageRecord | undefined> {
  const { attempt, input } = await attemptOf(parts, sent);
  const { messages } = parts.direct;
  const held = await messages.retakeIfExpired(lost, lost.attemptId, attempt, parts.clock.now());
  if (held === undefined) {
    await droppedFiles(parts, sent.key.tenantId, attempt.attemptId);
    return messages.findByKey(lost);
  }
  await settledLostAttempt({ files: parts.files.store, clock: parts.clock }, lost);
  return ran(parts, caller, held, { skill: sent.skill, input });
}

/** The message once its attempt in flight ended or expired (the store read every `POLL_EVERY`). */
async function awaited(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  running: A2ADirectMessageRecord,
): Promise<A2ADirectMessageRecord | undefined> {
  for (;;) {
    caller.signal.throwIfAborted();
    if (parts.clock.now().getTime() >= running.expiresAt.getTime()) return running;
    await parts.clock.sleep(POLL_EVERY, caller.signal);
    const now = await parts.direct.messages.findByKey(running);
    if (now?.attemptId !== running.attemptId || now.state !== A2ADirectMessageState.InFlight)
      return now;
  }
}

/** One round: the message as it is, moved on by this call where it can — its reply when it has one. */
async function round(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  sent: DirectMessage,
): Promise<A2ADirectMessageRecord | undefined> {
  const found = await parts.direct.messages.findByKey(sent.key);
  if (found === undefined) return saved(parts, caller, sent);
  if (found.requestHash !== sent.requestHash) throw reused();
  if (found.state === A2ADirectMessageState.Completed) return found;
  if (found.expiresAt.getTime() > parts.clock.now().getTime()) return awaited(parts, caller, found);
  return retaken(parts, caller, found, sent);
}

/** What a new message to `skill` asks, checked before anything is kept. */
async function directMessageOf(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  message: Message,
  skill: ServedSkill,
): Promise<DirectMessage> {
  const inputFor = inputForOf(parts, caller, message, skill);
  // Stryker disable next-line StringLiteral: no file, so no file id: any attempt id checks the same
  if (message.parts.every((part) => !isFilePart(part))) await inputFor("");
  const limit = meshLimitOf(parts, caller, skill);
  if (limit !== undefined)
    throw invalidParams(limit.code, `the message was rejected: ${limit.code}`);
  const messageId = checkedCallerKey("messageId", message.messageId);
  const contextId =
    message.contextId === ""
      ? parts.ids.newThreadId()
      : checkedCallerKey("contextId", message.contextId);
  return {
    key: { tenantId: caller.tenantId, ownerId: caller.ownerId, messageId },
    skill,
    requestHash: requestHashOf(skill.id, message),
    contextId,
    inputFor,
  };
}

/** The direct reply to a new message of `skill`. */
export async function directReply(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  message: Message,
  skill: ServedSkill,
): Promise<Message> {
  const sent = await directMessageOf(parts, caller, message, skill);
  for (let made = 0; made < ROUNDS; made += 1) {
    const now = await round(parts, caller, sent);
    if (now?.requestHash !== undefined && now.requestHash !== sent.requestHash) throw reused();
    if (now?.state === A2ADirectMessageState.Completed) return wireReplyOf(now, parts);
  }
  throw new A2AInternalError();
}
