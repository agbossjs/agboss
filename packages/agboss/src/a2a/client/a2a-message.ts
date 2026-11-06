import { createHash } from "node:crypto";
import { Message, Part, Role, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import type { Clock } from "../../infrastructure/clock.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import type { A2ARemotePeer } from "./a2a-card.js";
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
  readonly clock: Pick<Clock, "sleep">;
  readonly parts: readonly Part[];
  readonly skill: string | undefined;
  readonly contextId: string | undefined;
  /** A reply: the task it continues. */
  readonly taskId: string | undefined;
  /** `call.key`: a second call of this client in one step, apart from the first. */
  readonly key: string | undefined;
  /** What rides each attempt's message: the mesh's envelope and headers. */
  readonly sign: (message: Message) => A2AMeshSigned;
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
}

/** What the call's intent stores of the answer: plain JSON. */
export type AcceptResult =
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly contextId: string;
      /** Whether the mesh's envelope rode the message. */
      readonly mesh: boolean;
    }
  | { readonly kind: "message"; readonly message: string; readonly mesh: boolean };

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
): { message: Message; serviceParameters: Record<string, string>; isMeshed: boolean } {
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
    isMeshed: Object.keys(signed.metadata).length > 0,
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
function resultOf(agent: string, answer: Task | Message, mesh: boolean): AcceptResult {
  if ("messageId" in answer) {
    return { kind: "message", message: JSON.stringify(Message.toJSON(answer)), mesh };
  }
  const taskId = safeTaskIdOf(answer.id);
  const contextId = safeTaskIdOf(answer.contextId);
  if (taskId === undefined || contextId === undefined) {
    throw new A2ARemoteCallError({ agent, reason: A2ARemoteCallReason.MalformedAnswer });
  }
  return { kind: "task", taskId, contextId, mesh };
}

/** One `SendMessage`, its answer as stored; an error translated (codes only). */
export async function sentOf(
  call: AcceptCall,
  messageId: string,
): Promise<{ answer: Task | Message; result: AcceptResult }> {
  const { message, serviceParameters, isMeshed } = signedOf(call, messageId);
  const options = {
    serviceParameters,
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  };
  let answer: Task | Message;
  try {
    answer = await call.client.sendMessage(requestOf(message), options);
  } catch (error) {
    throw wireErrorOf(error, call.agent, A2AClientOperation.SendMessage, call.signal);
  }
  return { answer, result: resultOf(call.agent, answer, isMeshed) };
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
  };
}
