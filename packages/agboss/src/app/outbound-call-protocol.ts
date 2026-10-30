import { randomUUID } from "node:crypto";
import { errorRecordOf } from "../core/error-record.js";
import { ExecutionContextUnavailableError } from "../flow/context/errors.js";
import { currentFrame, rootFactsOf } from "../flow/context/frame.js";
import { OutboundCallEventOutcome } from "../infrastructure/execution-lease-event.repository.js";
import type { FencedEffectKey } from "../infrastructure/fenced-effect.repository.js";
import {
  OutboundCallStatus,
  stateOf,
  type OutboundCallRecord,
} from "../infrastructure/outbound-call.repository.js";
import {
  callOf,
  lookupOf,
  maskedFailureOf,
  outcomeOf,
  storedJson,
  told,
  type CallRun,
  type OutboundCallParts,
} from "./outbound-call-parts.js";
import {
  OutboundCallInFlightError,
  OutboundCallOutcomeStatus,
  OutboundCallPart,
  OutboundCallReconciliation,
  OutboundCallUnreconciledError,
  OutboundCallVerdict,
  type OutboundCallOptions,
  type OutboundCallOutcome,
} from "./outbound-calls.js";

export type { OutboundCallParts } from "./outbound-call-parts.js";

/**
 * The protocol of a call that leaves the system (#505), loaded on the first `OutboundCalls.send`:
 * the request masked for the store first (fails closed), then the intent of the key looked up
 * (fenced) and, by its state — completed: replayed; pending: reconciled; failed: sent again; none:
 * recorded (fenced), then sent. Before the network the lease is renewed (`confirmNow`); the answer
 * is written back fenced — a refusal there is a hand-over, and the new holder reconciles. A new
 * attempt is a compare-and-set on the intent as read — its status, attempt and attempt owner (a
 * random id per claim): a call that loses it sends nothing and reads the intent again, a bounded
 * number of times. A call this instance is making now is joined, never reconciled or resent.
 */

/** How many times a call reads its intent when other calls keep moving it first. */
const MAX_READS = 3;

/** Another call holds the key: nothing sent. */
const inFlight = <TRequest, TResult>(run: CallRun<TRequest, TResult>): OutboundCallInFlightError =>
  new OutboundCallInFlightError({ ...run.options, name: run.key.name });

/** What a call of this instance is known by while it is made: its key's row. */
const liveKeyOf = (key: FencedEffectKey): string =>
  [key.tenantId, key.scopeKey, key.idempotencyKey, key.name].join("\u0000");

/** Sends attempt `attempt`: the lease renewed first, the answer stored fenced; an error recorded. */
async function sendNow<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
): Promise<OutboundCallOutcome<TResult>> {
  const { repository } = run.parts;
  await run.frame.execution.lease?.confirmNow();
  const call = callOf(run, attempt);
  let answer: TResult;
  try {
    answer = await run.options.send(call);
  } catch (error) {
    // aborted (a lost lease, a cancel): nobody knows what arrived — the intent stays pending
    if (!call.signal.aborted) {
      await repository.markFailed(run.key, await maskedFailureOf(run, error));
      told(run, OutboundCallEventOutcome.Failed, [OutboundCallStatus.Failed, attempt]);
    }
    throw error;
  }
  // stored masked; the step gets the answer as it is
  await repository.markCompleted(run.key, await storedJson(run, OutboundCallPart.Result, answer));
  told(run, OutboundCallEventOutcome.Sent, [OutboundCallStatus.Completed, attempt]);
  return outcomeOf(run, OutboundCallOutcomeStatus.Sent, answer, attempt);
}

/**
 * `found` moved to its next attempt — only while it is as read (a compare-and-set) — then sent;
 * `undefined` when another call moved it first: nothing sent.
 */
async function movedAndSent<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
  isNotSent: boolean,
): Promise<OutboundCallOutcome<TResult> | undefined> {
  const claim = { attempt: found.attempt + 1, attemptOwner: randomUUID() };
  const { attempt } = claim;
  if (!(await run.parts.repository.markPending(run.key, stateOf(found), claim))) return undefined;
  if (isNotSent) told(run, OutboundCallEventOutcome.NotSent, [OutboundCallStatus.Pending, attempt]);
  return sendNow(run, attempt);
}

/** The pending intent `found`, reconciled: completed, sent again, or the step fails. */
async function reconciled<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): Promise<OutboundCallOutcome<TResult> | undefined> {
  const unreconciled = (reason: string, cause?: unknown): OutboundCallUnreconciledError => {
    told(run, OutboundCallEventOutcome.Unknown, [OutboundCallStatus.Pending, found.attempt]);
    return new OutboundCallUnreconciledError(
      { ...run.options, name: run.key.name, idempotencyKey: run.idempotencyKey, reason },
      cause,
    );
  };
  let verdict: unknown;
  try {
    verdict = await run.options.reconcile(lookupOf(run, found.request, found.attempt));
  } catch (error) {
    throw unreconciled(`reconcile threw: ${errorRecordOf(error).message}`, error);
  }
  if (!(verdict instanceof OutboundCallReconciliation))
    throw unreconciled("reconcile gave no OutboundCallReconciliation verdict");
  if (verdict.verdict === OutboundCallVerdict.NotSent) return movedAndSent(run, found, true);
  if (verdict.verdict === OutboundCallVerdict.Unknown) throw unreconciled(verdict.reason);
  const stored = await storedJson(run, OutboundCallPart.Result, verdict.result);
  await run.parts.repository.markCompleted(run.key, stored);
  told(run, OutboundCallEventOutcome.Reconciled, [OutboundCallStatus.Completed, found.attempt]);
  return outcomeOf(run, OutboundCallOutcomeStatus.Reconciled, verdict.result, found.attempt);
}

/** The first attempt: the intent recorded (fenced), then sent. */
async function recordedAndSent<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  request: string,
): Promise<OutboundCallOutcome<TResult>> {
  const { frame, key, options } = run;
  const isSaved = await run.parts.repository.saveIfAbsent(key, {
    rootExecutionId: rootFactsOf(frame.execution).executionId,
    executionId: frame.execution.executionId,
    workflow: frame.execution.workflow.name,
    target: options.target,
    operation: options.operation,
    idempotencyKey: run.idempotencyKey,
    request,
    attempt: 1,
    attemptOwner: randomUUID(),
    step: { nodeId: frame.step.nodeId, visitNumber: frame.step.visitNumber },
  });
  if (!isSaved) throw inFlight(run); // another call recorded the same key at the same moment
  told(run, OutboundCallEventOutcome.Recorded, [OutboundCallStatus.Pending, 1]);
  return sendNow(run, 1);
}

/**
 * One read of the intent and what follows: recorded and sent, replayed, reconciled or sent again;
 * `undefined` when another call moved it first. A read after such a loss that finds it pending
 * finds that call sending: in flight.
 */
async function settled<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  request: string,
  read: number,
): Promise<OutboundCallOutcome<TResult> | undefined> {
  const found = await run.parts.repository.findByKey(run.key);
  if (found === undefined) return recordedAndSent(run, request);
  if (found.status === OutboundCallStatus.Completed) {
    // a replay gives the result as it was stored: masked by the PII policies
    const stored: unknown = JSON.parse(found.result ?? "null");
    told(run, OutboundCallEventOutcome.Replayed, [OutboundCallStatus.Completed, found.attempt]);
    return outcomeOf(run, OutboundCallOutcomeStatus.Replayed, stored, found.attempt);
  }
  if (found.status === OutboundCallStatus.Failed) return movedAndSent(run, found, false);
  if (read > 1) throw inFlight(run);
  return reconciled(run, found);
}

/** The reads of one call: until one settles it, at most `MAX_READS`, then in flight. */
async function sendOnce<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  request: string,
): Promise<OutboundCallOutcome<TResult>> {
  for (let read = 1; read <= MAX_READS; read += 1) {
    const outcome = await settled(run, request, read);
    if (outcome !== undefined) return outcome;
  }
  throw inFlight(run);
}

/** The outcome of the same call this instance is making now: shared, or its error. */
async function joinedTo<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  joined: Promise<OutboundCallOutcome<unknown>>,
): Promise<OutboundCallOutcome<TResult>> {
  const { signal } = run.frame.execution;
  signal.throwIfAborted();
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });
  const first = await Promise.race([joined, aborted]);
  told(run, OutboundCallEventOutcome.Joined, [OutboundCallStatus.Completed, first.attempt]);
  return outcomeOf(run, OutboundCallOutcomeStatus.Joined, first.result, first.attempt);
}

/** `OutboundCalls.send`: the protocol, in the step's frame. */
export async function sendOutboundCall<TRequest, TResult>(
  parts: OutboundCallParts,
  key: FencedEffectKey,
  options: OutboundCallOptions<TRequest, TResult>,
): Promise<OutboundCallOutcome<TResult>> {
  const frame = currentFrame();
  if (frame === undefined)
    throw ExecutionContextUnavailableError.outside({ consumer: "OutboundCalls", field: "send" });
  const run: CallRun<TRequest, TResult> = {
    parts,
    key,
    options,
    frame,
    idempotencyKey: `${key.idempotencyKey}:${key.name}`,
  };
  // masked for the store, within the limit, before anything is read, recorded or sent
  const request = await storedJson(run, OutboundCallPart.Request, options.request);
  const live = liveKeyOf(key);
  const joined = parts.live.get(live);
  if (joined !== undefined) return joinedTo(run, joined);
  const outcome = sendOnce(run, request);
  parts.live.set(live, outcome);
  // a step aborted (a lost lease, a cancel, its timeout) owns its call no more: never joined again
  const { signal } = frame.execution;
  const leave = (): void => {
    if (parts.live.get(live) === outcome) parts.live.delete(live);
  };
  signal.addEventListener("abort", leave, { once: true });
  try {
    return await outcome;
  } finally {
    signal.removeEventListener("abort", leave);
    leave();
  }
}
