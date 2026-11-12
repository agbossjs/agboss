import { Part, type Task } from "@a2a-js/sdk";
import { createHash } from "node:crypto";
import { NotSentTrust } from "../../app/outbound-call-contract.js";
import { OutboundCallReconciliation, type OutboundCallLookup } from "../../app/outbound-calls.js";
import type { OutboundCallNotSent } from "../../app/outbound-call-types.js";
import { stableJson } from "../../turns/index.js";
import { A2APeerKind, type A2ARemotePeer } from "./a2a-card.js";
import type { AcceptCall, AcceptResult } from "./a2a-message.js";
import { safeTaskIdOf } from "./a2a-task-errors.js";
import { A2AClientOperation } from "./a2a-client-errors.js";
import { checkedTask } from "./a2a-task-view.js";
import { wireErrorOf } from "./a2a-wire-errors.js";

/**
 * How a pending accept is reconciled (#809, design §4.3.1), by the peer's trust as it was when the
 * call was recorded:
 *
 * - **AGBoss peer** (its card declares `idempotencyRetention`): `notSent()` under
 *   `NotSentTrust.KeyReplay` bounded by that retention — the same deterministic `messageId` is sent
 *   again and the agent's dedupe returns the same task; past it nothing is sent.
 * - **Foreign peer:** a reply to a known task is completed only when the task's history holds the
 *   reply's `messageId`; anything else is unknown — `OutboundCallUnreconciledError`, nothing resent.
 * - **The peer's trust changed** since the intent was recorded (its card): unknown.
 */

/** What the intent stores of the request (masked like every outbound request). */
export interface AcceptRequest {
  readonly agent: string;
  readonly url: string;
  readonly skill: string | null;
  readonly contextId: string | null;
  readonly taskId: string | null;
  readonly parts: string;
  /** The peer's trust when the call was first made: a resend relies on it, never on today's card. */
  readonly peer: { readonly kind: A2APeerKind; readonly idempotencyRetention: number | null };
}

/** How much of a foreign task's history a reply's reconcile reads for its `messageId`. */
export const RECONCILE_HISTORY = 100;

/** How far `reconcile`'s `notSent()` is trusted: an AGBoss peer's declared dedupe window. */
export function notSentOf(peer: A2ARemotePeer): OutboundCallNotSent {
  return peer.kind === A2APeerKind.AGBoss
    ? { trust: NotSentTrust.KeyReplay, keyRetention: peer.idempotencyRetention }
    : { trust: NotSentTrust.Lookup }; // a foreign peer's reconcile never says notSent()
}

/** What the intent stores of a call's request: the parts as their wire JSON, the peer's trust. */
/**
 * A part as the call's intent stores it: a `raw` file as its fingerprint only (#859 — its SHA-256,
 * size, media type and name), so a file never fills the intent past `maxPayloadSize`.
 */
function storedPartOf(part: Part): unknown {
  const { content } = part;
  if (content?.$case !== "raw") return Part.toJSON(part);
  return {
    raw: {
      sha256: createHash("sha256").update(content.value).digest("hex"),
      sizeBytes: content.value.byteLength,
    },
    mediaType: part.mediaType,
    filename: part.filename,
  };
}

export const acceptRequestOf = (call: AcceptCall): AcceptRequest => ({
  agent: call.agent,
  url: call.url,
  skill: call.skill ?? null,
  contextId: call.contextId ?? null,
  taskId: call.taskId ?? null,
  parts: JSON.stringify(call.parts.map(storedPartOf)),
  peer: { kind: call.peer.kind, idempotencyRetention: call.peer.idempotencyRetention ?? null },
});

/**
 * What identifies a call in its stored request — the agent, its URL, the skill, the task a reply
 * continues, the peer's trust — never its parts (masked as stored, so they differ from the call's).
 */
const identityOf = (request: object): readonly unknown[] =>
  ["agent", "url", "skill", "taskId", "peer"].map(
    (field): unknown => (Reflect.get(request, field) as unknown) ?? null,
  );

/** The identity a stored request names (its JSON, as stored); none for one that is no object. */
function storedIdentityOf(storedRequest: string): unknown {
  const stored: unknown = JSON.parse(storedRequest);
  return typeof stored === "object" && stored !== null ? identityOf(stored) : null;
}

export const UNKNOWN_FOREIGN =
  "foreign A2A peer: it declares no messageId deduplication, so a SendMessage of unknown outcome is never sent again";
export const UNKNOWN_REPLY =
  "foreign A2A peer: the task's history does not show the reply, and whether it is on its way cannot be told — it is never sent again";
export const UNKNOWN_PEER =
  "the agent changed since the call was recorded (its url, skill or card's trust): what was trusted then is not now, so nothing is sent again";

/** What a pending intent was: asked of the agent, or of nobody. */
export async function reconciliationOf(
  call: AcceptCall,
  lookup: Pick<OutboundCallLookup, "storedRequest">,
  messageId: string,
): Promise<OutboundCallReconciliation<AcceptResult>> {
  const stored = storedIdentityOf(lookup.storedRequest);
  const isSameCall = stableJson(stored) === stableJson(identityOf(acceptRequestOf(call)));
  if (!isSameCall) return OutboundCallReconciliation.unknown({ reason: UNKNOWN_PEER });
  // the agent deduplicates the messageId: sending it again returns the same task
  if (call.peer.kind === A2APeerKind.AGBoss) return OutboundCallReconciliation.notSent();
  if (call.taskId === undefined) {
    return OutboundCallReconciliation.unknown({ reason: UNKNOWN_FOREIGN });
  }
  const options = call.signal === undefined ? {} : { signal: call.signal };
  // a failed read throws (codes only): OutboundCalls keeps it as the unreconciled call's cause
  let read: Task;
  try {
    read = await call.client.getTask(
      { tenant: "", id: call.taskId, historyLength: RECONCILE_HISTORY },
      options,
    );
  } catch (error) {
    throw wireErrorOf(error, call.agent, A2AClientOperation.GetTask, call.signal);
  }
  const task = checkedTask({ agent: call.agent, taskId: call.taskId }, read);
  const isArrived = task.history.some((message) => message.messageId === messageId);
  return isArrived
    ? OutboundCallReconciliation.completed<AcceptResult>({
        kind: "task",
        mesh: false, // a foreign peer: no mesh rode
        taskId: call.taskId,
        contextId: call.contextId ?? safeTaskIdOf(task.contextId) ?? "",
      })
    : OutboundCallReconciliation.unknown({ reason: UNKNOWN_REPLY });
}
