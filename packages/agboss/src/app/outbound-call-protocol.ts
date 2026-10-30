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
 * is written back fenced — a refusal there is a hand-over, and the new holder reconciles.
 */

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

/** The pending intent `found`, reconciled: completed, sent again, or the step fails. */
async function reconciled<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): Promise<OutboundCallOutcome<TResult>> {
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
  if (verdict.verdict === OutboundCallVerdict.NotSent) {
    await run.parts.repository.markPending(run.key, found.attempt + 1);
    told(run, OutboundCallEventOutcome.NotSent, [OutboundCallStatus.Pending, found.attempt + 1]);
    return sendNow(run, found.attempt + 1);
  }
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
    step: { nodeId: frame.step.nodeId, visitNumber: frame.step.visitNumber },
  });
  if (isSaved) told(run, OutboundCallEventOutcome.Recorded, [OutboundCallStatus.Pending, 1]);
  if (!isSaved)
    throw new OutboundCallUnreconciledError({
      ...options,
      name: key.name,
      idempotencyKey: run.idempotencyKey,
      reason: "another call recorded the same key at the same moment",
    });
  return sendNow(run, 1);
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
  const found = await parts.repository.findByKey(key);
  if (found === undefined) return recordedAndSent(run, request);
  if (found.status === OutboundCallStatus.Completed) {
    // a replay gives the result as it was stored: masked by the PII policies
    const stored: unknown = JSON.parse(found.result ?? "null");
    told(run, OutboundCallEventOutcome.Replayed, [OutboundCallStatus.Completed, found.attempt]);
    return outcomeOf(run, OutboundCallOutcomeStatus.Replayed, stored, found.attempt);
  }
  if (found.status === OutboundCallStatus.Pending) return reconciled(run, found);
  await parts.repository.markPending(key, found.attempt + 1);
  return sendNow(run, found.attempt + 1);
}
