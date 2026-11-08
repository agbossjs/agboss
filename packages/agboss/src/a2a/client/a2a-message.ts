import { createHash } from "node:crypto";
import { Message, Part, Role, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import type { Clock } from "../../infrastructure/clock.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { A2APeerKind, type A2ARemotePeer } from "./a2a-card.js";
import { meshRefusalOf } from "./a2a-outcome.js";
import {
  A2AClientOperation,
  A2ARemoteCallError,
  A2ARemoteCallReason,
} from "./a2a-client-errors.js";
import type { A2AMeshSigned } from "./a2a-mesh-seam.js";
import { safeTaskIdOf } from "./a2a-task-errors.js";
import { A2ANotSentError } from "./a2a-transport.js";
import { wireErrorOf } from "./a2a-wire-errors.js";

/**
 * One `SendMessage` of an accept (#809): the message as it is sent — its deterministic `messageId`,
 * the skill, what the mesh signs —, `returnImmediately`, and what is stored of the answer: a task's
 * ids (checked), or a stateless message's wire JSON.
 */

/** One message to accept. */
export interface AcceptCall {
  /** The client's name (its `@A2AAgent`'s): the call's name and target. */
  readonly agent: string;
  /** The agent's base URL: part of what the call's intent records. */
  readonly url: string;
  readonly peer: A2ARemotePeer;
  /** The SDK client's two calls an accept makes (the send, a foreign reply's reconcile). */
  readonly client: Pick<Client, "sendMessage" | "getTask">;
  readonly clock: Pick<Clock, "sleep" | "now">;
  readonly parts: readonly Part[];
  readonly skill: string | undefined;
  readonly contextId: string | undefined;
  /** A reply: the task it continues. */
  readonly taskId: string | undefined;
  /** `call.key`: a second call of this client in one step, apart from the first. */
  readonly key: string | undefined;
  /** What rides each attempt's message: the mesh's envelope and headers. */
  readonly sign: (message: Message) => A2AMeshSigned;
  /**
   * Whether the agent's answer to the send of `messageId` echoed the mesh extension (#810, spec
   * §4.6: an agent names the extensions it activated); `undefined` when it was not asked.
   */
  readonly meshEchoOf?: (messageId: string) => boolean | undefined;
  readonly signal: AbortSignal | undefined;
}

/** What the agent answered: a task (its ids, or as returned), or a stateless message. */
export interface Accepted {
  readonly taskId: string | undefined;
  readonly contextId: string | undefined;
  /** The task as the accept returned it — absent once replayed (only its ids are stored). */
  readonly task: Task | undefined;
  readonly message: Message | undefined;
  /** Whether the message reached the agent in this call (sent or reconciled), not replayed. */
  readonly isNew: boolean;
  readonly messageId: string;
  /** Whether the mesh's envelope rode the message — as stored, so a replay says it too. */
  readonly isMeshed: boolean;
  /**
   * The `bodyHash` the envelope bound (#810), as stored: what the run report must bind — a replay
   * verifies the report of the message an earlier pass sent.
   */
  readonly bodyHash?: string;
  /**
   * When the message was first accepted (#810, ISO 8601 on the `Clock`), as stored: the date of the
   * price's ledger entry, the same on every pass that charges it.
   */
  readonly acceptedAt?: string;
  /**
   * Whether the agent refused the call before anything ran (#849): its task `REJECTED` at the
   * accept — a mesh loop, a chain past its `maxMeshHops` —, as stored, so a replay knows it too.
   * Nothing ran, so nothing is charged, its price neither.
   */
  readonly isRefused: boolean;
}

/** What the call's intent stores of the answer: plain JSON. */
export type AcceptResult =
  | ({
      readonly kind: "task";
      readonly taskId: string;
      readonly contextId: string;
      /** Whether the mesh's envelope rode the message (and the agent activated it, #810). */
      readonly mesh: boolean;
    } & AcceptFacts)
  | ({ readonly kind: "message"; readonly message: string; readonly mesh: boolean } & AcceptFacts);

/** What an accept stores besides its answer (#810): what charging it the same on every pass needs. */
export interface AcceptFacts {
  /** The envelope's `bodyHash`, when the mesh rode. */
  readonly bodyHash?: string;
  /** When the agent accepted it (ISO 8601). */
  readonly acceptedAt?: string;
  /** The agent refused it at the accept, before anything ran: its task `REJECTED` (#849). */
  readonly refused?: true;
}

/** A UUID (version 5 layout) over the tenant and the call's idempotency key: one per call, ever. */
export function messageIdOf(tenantId: string, idempotencyKey: string): string {
  const hex = createHash("sha256")
    .update(
      `agboss/a2a/message/v1\u0000${String(tenantId.length)}:${tenantId}\u0000${idempotencyKey}`,
    )
    .digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** The message of a call, under `messageId`, before anything rides it. */
function messageOf(call: AcceptCall, messageId: string): Message {
  const skill =
    call.skill === undefined ? undefined : { [A2A_SKILLS_EXTENSION]: { skill: call.skill } };
  return {
    messageId,
    contextId: call.contextId ?? "",
    taskId: call.taskId ?? "",
    role: Role.ROLE_USER,
    parts: [...call.parts],
    metadata: skill,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** The message as sent: what the mesh signs added to its metadata and its request's headers. */
function signedOf(
  call: AcceptCall,
  messageId: string,
): {
  message: Message;
  serviceParameters: Record<string, string>;
  bodyHash: string | undefined;
} {
  const message = messageOf(call, messageId);
  let signed: A2AMeshSigned;
  try {
    signed = call.sign(message);
  } catch (error) {
    throw new A2ANotSentError(error); // the envelope could not be made: nothing went out
  }
  const metadata = { ...message.metadata, ...signed.metadata };
  return {
    message: { ...message, metadata: Object.keys(metadata).length === 0 ? undefined : metadata },
    serviceParameters: { ...signed.serviceParameters },
    bodyHash: signed.bodyHash,
  };
}

const requestOf = (message: Message): SendMessageRequest => ({
  tenant: "",
  message,
  configuration: {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately: true,
  },
  metadata: undefined,
});

/** What is stored of an answer: a task's ids, checked — or a stateless message's wire JSON. */
function resultOf(
  agent: string,
  answer: Task | Message,
  mesh: boolean,
  facts: AcceptFacts,
): AcceptResult {
  if ("messageId" in answer) {
    return { kind: "message", message: JSON.stringify(Message.toJSON(answer)), mesh, ...facts };
  }
  const taskId = safeTaskIdOf(answer.id);
  const contextId = safeTaskIdOf(answer.contextId);
  if (taskId === undefined || contextId === undefined) {
    throw new A2ARemoteCallError({ agent, reason: A2ARemoteCallReason.MalformedAnswer });
  }
  return { kind: "task", taskId, contextId, mesh, ...facts };
}

/**
 * A task the agent refused as it accepted it (#849): only an AGBoss agent the mesh rode to, whose
 * task is `REJECTED` with a mesh limit (a loop, the hop limit) — refused before anything ran there.
 * Any other REJECTED answer (a foreign agent's may come after work) is charged as accepted.
 */
const isRefusedAnswer = (call: AcceptCall, answer: Task | Message, isMeshed: boolean): boolean =>
  call.peer.kind === A2APeerKind.AGBoss &&
  isMeshed &&
  // Stryker disable next-line StringLiteral: a message has no status, so it is no refusal either way
  !("messageId" in answer) &&
  meshRefusalOf(answer) !== undefined;

/** One `SendMessage`, its answer as stored; an error translated (codes only). */
export async function sentOf(
  call: AcceptCall,
  messageId: string,
): Promise<{ answer: Task | Message; result: AcceptResult }> {
  const signed = signedOf(call, messageId);
  const options = {
    serviceParameters: signed.serviceParameters,
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  };
  let answer: Task | Message;
  let isEchoed: boolean | undefined;
  try {
    answer = await call.client.sendMessage(requestOf(signed.message), options);
  } catch (error) {
    throw wireErrorOf(error, call.agent, A2AClientOperation.SendMessage, call.signal);
  } finally {
    isEchoed = call.meshEchoOf?.(messageId);
  }
  // the envelope rode (it binds a body hash), and the agent says it activated the mesh: an agent
  // that does not echo it gave none of its guarantees — unmeshed, said in its peer and step record
  const bodyHash = isEchoed === true ? signed.bodyHash : undefined;
  const acceptedAt = call.clock.now().toISOString();
  const facts: AcceptFacts = {
    ...(bodyHash === undefined ? {} : { bodyHash }),
    acceptedAt,
    ...(isRefusedAnswer(call, answer, bodyHash !== undefined) ? { refused: true } : {}),
  };
  return { answer, result: resultOf(call.agent, answer, bodyHash !== undefined, facts) };
}

/** An accepted answer from what was stored. */
export function acceptedOf(
  result: AcceptResult,
  answer: Task | Message | undefined,
  isNew: boolean,
  messageId: string,
): Accepted {
  if (result.kind === "message") {
    const message =
      answer !== undefined && "messageId" in answer
        ? answer
        : Message.fromJSON(JSON.parse(result.message));
    return {
      taskId: undefined,
      contextId: message.contextId,
      task: undefined,
      message,
      isNew,
      messageId,
      isMeshed: result.mesh,
      isRefused: false,
      ...factsOf(result),
    };
  }
  const task = answer !== undefined && !("messageId" in answer) ? answer : undefined;
  return {
    taskId: result.taskId,
    contextId: result.contextId,
    task,
    message: undefined,
    isNew,
    messageId,
    isMeshed: result.mesh,
    isRefused: result.refused === true,
    ...factsOf(result),
  };
}

/** The facts an accept stored (#810), as an accepted answer carries them. */
const factsOf = (result: AcceptResult): AcceptFacts => ({
  ...(result.bodyHash === undefined ? {} : { bodyHash: result.bodyHash }),
  ...(result.acceptedAt === undefined ? {} : { acceptedAt: result.acceptedAt }),
});
