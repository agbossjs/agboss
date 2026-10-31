import { randomUUID } from "node:crypto";
import { OutboundCallLeaseState } from "../infrastructure/execution-lease-event.repository.js";
import { errorRecordOf } from "../core/error-record.js";
import { ExecutionContextUnavailableError } from "../flow/context/errors.js";
import { currentFrame, rootFactsOf } from "../flow/context/frame.js";
import { OutboundCallEventOutcome } from "../infrastructure/execution-lease-event.repository.js";
import type { FencedEffectKey } from "../infrastructure/fenced-effect.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRecord,
} from "../infrastructure/outbound-call.repository.js";
import {
  callKeyOf,
  checkedCall,
  keyedByRequest,
  replayedFromOf,
  stateOf,
} from "./outbound-call-business.js";
import {
  callOf,
  lookupOf,
  maskedFailureOf,
  notStoredOf,
  outcomeOf,
  storedJson,
  storedResultOf,
  told,
  type CallRun,
  type OutboundCallParts,
} from "./outbound-call-parts.js";
import {
  OutboundCallInFlightError,
  OutboundCallOutcomeStatus,
  OutboundCallPart,
  OutboundCallReconciliation,
  OutboundCallResultNotStoredError,
  OutboundCallVerdict,
  type OutboundCallOptions,
  type OutboundCallOutcome,
} from "./outbound-calls.js";

import { fencedEnd, leaseSuperseded, superseded, unreconciledOf } from "./outbound-call-endings.js";
import { joinedOrMade, owning } from "./outbound-call-join.js";

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

/**
 * Sends attempt `attempt` of `owner`: the lease renewed first, nothing sent once the step aborted;
 * the answer stored fenced, only while `owner` still owns the attempt; an error recorded so too.
 */
async function sendNow<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
  owner: string,
): Promise<OutboundCallOutcome<TResult>> {
  const { repository } = run.parts;
  const lease = run.frame.execution.lease;
  await lease?.confirmNow();
  run.frame.execution.signal.throwIfAborted();
  const call = callOf(run, attempt);
  // nothing leaves after the holder's fence (#533): checked on its monotonic clock right before
  lease?.assertHeld();
  let answer: TResult;
  try {
    answer = await run.options.send(call);
  } catch (error) {
    // aborted (a lost lease, a cancel): nobody knows what arrived — the intent stays pending
    if (!call.signal.aborted) {
      run.answer.isAnswered = true;
      const failure = await maskedFailureOf(run, error);
      const isFailed = () => repository.markFailed(run.key, owner, failure);
      if (!(await fencedEnd(run, attempt, isFailed))) await superseded(run, attempt);
      else told(run, OutboundCallEventOutcome.Failed, [OutboundCallStatus.Failed, attempt]);
    }
    throw error;
  }
  // stored masked (or a marker: the call happened); the step gets the answer as it is
  const stored = await storedResultOf(run, answer);
  const isCompleted = () => repository.markCompleted(run.key, owner, stored);
  if (!(await fencedEnd(run, attempt, isCompleted))) {
    await superseded(run, attempt);
    return outcomeOf(run, OutboundCallOutcomeStatus.Superseded, answer, attempt);
  }
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
  const { attempt, attemptOwner } = claim;
  return owning(run, attemptOwner, async () => {
    if (!(await run.parts.repository.markPending(run.key, stateOf(found), claim))) return undefined;
    if (isNotSent)
      told(run, OutboundCallEventOutcome.NotSent, [OutboundCallStatus.Pending, attempt]);
    return sendNow(run, attempt, attemptOwner);
  });
}

/** The pending intent `found`, reconciled: completed, sent again, or the step fails. */
async function reconciled<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): Promise<OutboundCallOutcome<TResult> | undefined> {
  const unreconciled = (reason: string, cause?: unknown) =>
    unreconciledOf(run, found, reason, cause);
  let verdict: unknown;
  try {
    verdict = await run.options.reconcile(lookupOf(run, found.request, found.attempt));
  } catch (error) {
    throw await unreconciled(`reconcile threw: ${errorRecordOf(error).message}`, error);
  }
  if (!(verdict instanceof OutboundCallReconciliation))
    throw await unreconciled("reconcile gave no OutboundCallReconciliation verdict");
  if (verdict.verdict === OutboundCallVerdict.NotSent) return movedAndSent(run, found, true);
  if (verdict.verdict === OutboundCallVerdict.Unknown) throw await unreconciled(verdict.reason);
  const stored = await storedResultOf(run, verdict.result);
  // settled for its owner, which is gone; one that moved it on meanwhile wins: read again
  if (!(await run.parts.repository.markCompleted(run.key, found.attemptOwner, stored)))
    return undefined;
  told(run, OutboundCallEventOutcome.Reconciled, [OutboundCallStatus.Completed, found.attempt]);
  return outcomeOf(run, OutboundCallOutcomeStatus.Reconciled, verdict.result, found.attempt);
}

/** The first attempt: the intent recorded (fenced), then sent. */
async function recordedAndSent<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  request: string,
): Promise<OutboundCallOutcome<TResult>> {
  const { frame, key, options } = run;
  const owner = randomUUID();
  return owning(run, owner, async () => {
    const isSaved = await run.parts.repository.saveIfAbsent(key, {
      rootExecutionId: rootFactsOf(frame.execution).executionId,
      executionId: frame.execution.executionId,
      workflow: frame.execution.workflow.name,
      target: options.target,
      operation: options.operation,
      idempotencyKey: run.idempotencyKey,
      request,
      attempt: 1,
      attemptOwner: owner,
      step: { nodeId: frame.step.nodeId, visitNumber: frame.step.visitNumber },
    });
    if (!isSaved) throw inFlight(run); // another call recorded the same key at the same moment
    told(run, OutboundCallEventOutcome.Recorded, [OutboundCallStatus.Pending, 1]);
    return sendNow(run, 1, owner);
  });
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
  if ((await checkedCall(run, found)) === OutboundCallLeaseState.Superseded)
    leaseSuperseded(run, found);
  if (found.status === OutboundCallStatus.Completed) return replayed(run, found);
  if (found.status === OutboundCallStatus.Failed) return movedAndSent(run, found, false);
  if (read > 1) throw inFlight(run);
  return reconciled(run, found);
}

/**
 * A completed intent's stored result — masked by the PII policies — and who made it (#508); one
 * whose result was not stored is `OutboundCallResultNotStoredError`, nothing sent again.
 */
function replayed<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): OutboundCallOutcome<TResult> {
  const stored: unknown = JSON.parse(found.result ?? "null");
  // answered, its result not stored (#508): no result to give, never the marker as one
  const notStored = notStoredOf(stored);
  if (notStored !== undefined)
    throw new OutboundCallResultNotStoredError({ ...run.options, name: run.key.name }, notStored);
  const replayedFrom = replayedFromOf(run.key, found);
  const moved = [OutboundCallStatus.Completed, found.attempt] as const;
  told(run, OutboundCallEventOutcome.Replayed, moved, { replayedFrom });
  const outcome = outcomeOf(run, OutboundCallOutcomeStatus.Replayed, stored, found.attempt);
  return replayedFrom === undefined ? outcome : { ...outcome, replayedFrom };
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

/** `OutboundCalls.send`: the protocol, in the step's frame. */
export async function sendOutboundCall<TRequest, TResult>(
  parts: OutboundCallParts,
  stepKey: FencedEffectKey,
  options: OutboundCallOptions<TRequest, TResult>,
): Promise<OutboundCallOutcome<TResult>> {
  const key = keyedByRequest(stepKey, options.request);
  const frame = currentFrame();
  if (frame === undefined)
    throw ExecutionContextUnavailableError.outside({ consumer: "OutboundCalls", field: "send" });
  const run: CallRun<TRequest, TResult> = {
    parts,
    key,
    options,
    frame,
    idempotencyKey: callKeyOf(key),
    // Stryker disable next-line ObjectLiteral: `isAnswered` is only read as a truth value, where a missing one is `false`
    answer: { isAnswered: false },
  };
  // masked for the store, within the limit, before anything is read, recorded or sent
  const request = await storedJson(run, OutboundCallPart.Request, options.request);
  return joinedOrMade(run, () => sendOnce(run, request));
}
