import { ConfigError } from "../../core/error-families/config-errors.js";
import { A2AError } from "../../core/error-families/remote-errors.js";
import { randomUUID } from "node:crypto";
import {
  OutboundCallSendStatus,
  type OutboundCall,
  type OutboundCallOutcome,
  type IdempotencySendOptions,
} from "../../app/outbound-call-types.js";
import { currentFrame } from "../../flow/context/frame.js";
import { liveExecutionContextOf } from "../../flow/context/live-context.js";
import { stableJson } from "../../turns/index.js";
import { hours, minutes, seconds, type Milliseconds } from "../../units/index.js";
import { A2APeerKind, type A2ARemotePeer } from "./a2a-card.js";
import { A2AContractRule } from "./a2a-client-errors.js";
import { a2aClientServicesOf } from "./a2a-client-services.js";
import { acceptRequestOf, recoveryOf, type AcceptRequest } from "./a2a-reconcile.js";
import {
  acceptedOf,
  messageIdOf,
  sentOf,
  type AcceptCall,
  type Accepted,
  type AcceptResult,
} from "./a2a-message.js";
import { isDefiniteSendFailure } from "./a2a-wire-errors.js";

/**
 * The accept round trip (#809, design §4.3.1): one `SendMessage` with `returnImmediately`, made
 * through `Idempotency.sendOnce` inside an execution — its intent recorded before it is sent, its answer
 * (the task's ids, or a stateless message) stored after, so a step that runs again replays it and
 * only waits; a send of unknown outcome left pending is reconciled (`a2a-reconcile.ts`), never
 * resent blindly. Outside an execution there is nothing to record into: the message is sent once
 * with a random `messageId` — again only to an AGBoss peer, which deduplicates it.
 */

/** Sends of unknown outcome made again in one call before it fails (an AGBoss peer only). */
export const MAX_ACCEPT_ATTEMPTS = 3;
const RETRY_DELAY = seconds(0.25);

/** Whether a send's error is of unknown outcome — the message may have arrived. */
export const isAmbiguous = (error: unknown): boolean =>
  (error instanceof A2AError.Unavailable && error.sent !== false) ||
  (error instanceof A2AError.Protocol && !isDefiniteSendFailure(error));

/** The names of the calls a frame made, with their requests: a second, other call is refused. */
const callsOfFrame = new WeakMap<object, Map<string, string>>();

/**
 * Claims `name` for `request` in `frame` (a step's): the same request again is the same call (a
 * retry), another one is `[a2a.repeated-call]` — it would replay the first one's answer.
 */
export function claimCallName(
  frame: object,
  name: string,
  call: AcceptCall,
  request: AcceptRequest,
): void {
  const made = callsOfFrame.get(frame) ?? new Map<string, string>();
  callsOfFrame.set(frame, made);
  const hash = stableJson(request);
  const earlier = made.get(name);
  if (earlier !== undefined && earlier !== hash) {
    throw new A2AError.Contract({
      agent: call.agent,
      rule: A2AContractRule.RepeatedCall,
      skill: call.skill ?? "",
      differences: [],
    });
  }
  made.set(name, hash);
}

/** The call's name in `Idempotency.sendOnce`: one per client, kind and `call.key` in a step. */
export const callNameOf = (call: AcceptCall): string =>
  [
    "a2a",
    call.agent,
    ...(call.taskId === undefined ? [] : ["reply"]),
    ...(call.key === undefined ? [] : [call.key]),
  ].join(".");

/**
 * Runs `attempt` up to `attempts` times while it fails of unknown outcome (`isAmbiguous`), waiting
 * `RETRY_DELAY` × the attempt on the `Clock` between them; any other failure, or the last, is thrown.
 */
async function withRetries<T>(
  call: AcceptCall,
  attempts: number,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let made = 1; ; made += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (made >= attempts || !isAmbiguous(error)) throw error;
      await call.clock.sleep((RETRY_DELAY * made) as Milliseconds, call.signal);
      // the Clock's sleep ends early, without an error, when the signal aborts
      call.signal?.throwIfAborted();
    }
  }
}

/** The one call of `Idempotency` an accept makes, for its own request and result. */
export interface AcceptOutboundCalls {
  sendOnce(
    options: IdempotencySendOptions<AcceptRequest, AcceptResult>,
  ): Promise<OutboundCallOutcome<AcceptResult>>;
}

/** What an accept inside an execution uses: the application's calls, the step's key and tenant. */
export interface AcceptRuntime {
  readonly outboundCalls: AcceptOutboundCalls;
  readonly tenantId: string;
  /** The step's frame: one name per call in it. */
  readonly frame: object;
}

/**
 * An accept's attempt bound and how long its intent is kept: two minutes at most, and well inside
 * an AGBoss peer's declared dedupe window (a resend must fit it); a week, or twice the window.
 */
function boundsOf(peer: A2ARemotePeer): {
  readonly timeout: Milliseconds;
  readonly ttl: Milliseconds;
} {
  const window = peer.idempotencyRetention;
  return {
    timeout: Math.min(minutes(2), (window ?? minutes(2)) / 2) as Milliseconds,
    ttl: Math.max(hours(168), (window ?? 0) * 2) as Milliseconds,
  };
}

/** How many sends one call makes before it fails: an AGBoss peer's resends, a foreign one's reconcile. */
const attemptsOf = (peer: A2ARemotePeer): number =>
  peer.kind === A2APeerKind.AGBoss ? MAX_ACCEPT_ATTEMPTS : 2;

/**
 * Sends through `Idempotency.sendOnce`: a send of unknown outcome left pending is asked again at once —
 * reconciled (an AGBoss peer: sent again with the same messageId; a foreign one: unreconciled).
 */
export async function acceptedThrough(call: AcceptCall, runtime: AcceptRuntime): Promise<Accepted> {
  const name = callNameOf(call);
  const request = acceptRequestOf(call);
  claimCallName(runtime.frame, name, call, request);
  let answer: Accepted["task"] | Accepted["message"];
  const messageIdFor = (key: string): string => messageIdOf(runtime.tenantId, key);
  const send = async (outbound: OutboundCall<AcceptRequest>): Promise<AcceptResult> => {
    const sent = await sentOf(call, messageIdFor(outbound.idempotencyKey));
    answer = sent.answer;
    return sent.result;
  };
  return withRetries(call, attemptsOf(call.peer), async () => {
    // a key per attempt: the fence's token as it is now
    const { timeout, ttl } = boundsOf(call.peer);
    const outcome = await runtime.outboundCalls.sendOnce({
      name,
      target: call.agent,
      operation: call.taskId === undefined ? "SendMessage" : "SendMessage (reply)",
      request,
      timeout,
      ttl,
      send,
      recovery: recoveryOf(call, messageIdFor),
      isDefiniteFailure: isDefiniteSendFailure,
    });
    const isNew =
      outcome.status === OutboundCallSendStatus.Sent ||
      outcome.status === OutboundCallSendStatus.Reconciled;
    return acceptedOf(outcome.result, answer, isNew, messageIdFor(outcome.idempotencyKey));
  });
}

/** Outside an execution: sent once, again only to a peer that deduplicates the messageId. */
export function acceptedDirectly(call: AcceptCall): Promise<Accepted> {
  const messageId = randomUUID();
  const attempts = call.peer.kind === A2APeerKind.AGBoss ? MAX_ACCEPT_ATTEMPTS : 1;
  return withRetries(call, attempts, async () => {
    const { answer, result } = await sentOf(call, messageId);
    return acceptedOf(result, answer, true, messageId);
  });
}

/**
 * Accepts one message: through `Idempotency.sendOnce` inside an execution, directly outside one (a
 * script's call). A frame of no composed application (a unit runner's) has nothing to record
 * into: the call is refused (`[a2a.outside-application]`) — never sent unrecorded from a step.
 */
export async function accept(call: AcceptCall): Promise<Accepted> {
  const frame = currentFrame();
  if (frame === undefined) return acceptedDirectly(call);
  const services = a2aClientServicesOf(frame.execution.tenant.application);
  if (services === undefined) {
    throw new ConfigError.Component({
      message: `[a2a.outside-application] ${call.agent} was called in a step of no application (a unit runner's): its call cannot be recorded, so it is not sent — mock the client (mockService), or run the step in testWith`,
    });
  }
  const executionContext = liveExecutionContextOf(undefined, call.agent);
  return acceptedThrough(call, {
    outboundCalls: services.outboundCalls(),
    tenantId: executionContext.tenant.tenantId,
    frame,
  });
}
