import { OutboundCallEventOutcome } from "../infrastructure/execution-audit-log.repository.js";
import { OutboundCallStatus } from "../infrastructure/outbound-call.repository.js";
import { failedOrPending, leftPending } from "./outbound-call-ambiguity.js";
import { fencedEnd, supersededErrorOf } from "./outbound-call-endings.js";
import {
  callOf,
  endExpiryOf,
  outcomeOf,
  storedResultOf,
  told,
  type CallRun,
} from "./outbound-call-parts.js";
import { OutboundCallSendStatus, type OutboundCallOutcome } from "./outbound-call-types.js";

/**
 * One attempt of a call (#505, #1317): the lease renewed first, nothing sent once the step aborted,
 * the attempt bounded by the call's `timeout`, the answer stored fenced.
 */

/** The bound of one attempt (#1317): the call's `timeout` on the application's clock, aborting its signal. */
function attemptTimeoutOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attemptEnd: AbortController,
  fired: { isFired: boolean },
): { readonly promise: Promise<never>; readonly stop: () => void } {
  const stopped = new AbortController();
  const promise: Promise<never> = run.parts.clock
    .sleep(run.options.timeout, stopped.signal)
    .then(() => {
      // `sleep` also resolves when it is stopped: the attempt ended first, so nothing timed out
      if (stopped.signal.aborted) return new Promise<never>(() => undefined);
      fired.isFired = true;
      const error = new DOMException(
        `outbound call "${run.key.name}" attempt passed its timeout of ${String(run.options.timeout)} ms`,
        "TimeoutError",
      );
      attemptEnd.abort(error);
      throw error;
    });
  // a timeout nobody raced any more must not be an unhandled rejection
  promise.catch(() => undefined);
  return {
    promise,
    stop: () => {
      stopped.abort();
    },
  };
}

/**
 * The answer of a send that passed its `timeout` (#1317): recorded like any answer — the intent
 * completed for its owner only while the lease and the attempt are still current (fenced) — so the
 * next call replays it and nothing is sent again. One that finds the lease handed over or a newer
 * attempt is told and logged as a late observation (`AttemptSuperseded`, the instance's log), never
 * a success: the new holder reconciles the intent by the call's key. An error or no answer leaves it
 * pending, in doubt. The owner is live until then, so no call of this instance resends meanwhile.
 */
async function lateAnswerOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
  owner: string,
  sending: Promise<TResult>,
): Promise<void> {
  try {
    const answer = await sending;
    const stored = await storedResultOf(run, answer);
    const isCompleted = () =>
      run.parts.repository.markCompleted(run.key, owner, stored, endExpiryOf(run));
    if (await fencedEnd(run, attempt, isCompleted)) {
      told(run, OutboundCallEventOutcome.Sent, [OutboundCallStatus.Completed, attempt]);
      return;
    }
    // a newer attempt took the intent over meanwhile: both reached the other system
    await supersededErrorOf(run, attempt);
  } catch {
    // a late error, or a fence that refused the late write (already logged by `fencedEnd`): the
    // intent stays as it is — pending for the next holder's reconciliation
  } finally {
    run.parts.owners.delete(owner);
  }
}

/**
 * Sends attempt `attempt` of `owner`: the lease renewed first, nothing sent once the step aborted;
 * the answer stored fenced, only while `owner` still owns the attempt; an error recorded so too.
 */
export async function sendNow<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
  owner: string,
): Promise<OutboundCallOutcome<TResult>> {
  const { repository } = run.parts;
  const lease = run.frame.execution.lease;
  await lease?.renewNow();
  run.frame.execution.signal.throwIfAborted();
  const attemptEnd = new AbortController();
  const timeout = { isFired: false };
  const stepSignal = run.frame.execution.signal;
  const timedOut = attemptTimeoutOf(run, attemptEnd, timeout);
  const call = callOf(run, attempt, AbortSignal.any([stepSignal, attemptEnd.signal]));
  // nothing leaves after the holder's fence (#533): checked on its monotonic clock right before
  lease?.assertHeld();
  let answer: TResult;
  const sending = (async () => run.options.send(call))();
  try {
    answer = await Promise.race([sending, timedOut.promise]);
  } catch (error) {
    if (timeout.isFired) {
      // the attempt's bound passed: the other system may have carried it out — never a definite
      // failure, whatever the call's classifier would say; the intent stays pending, in doubt, and
      // the send is still listened to: its late answer is recorded fenced, never lost (#1317)
      run.answer.isLate = true;
      run.answer.lateTail = lateAnswerOf(run, attempt, owner, sending);
      if (!stepSignal.aborted) {
        run.answer.isAnswered = true;
        leftPending(run, attempt, error);
      }
      throw error;
    }
    // aborted (a lost lease, a cancel): nobody knows what arrived — the intent stays pending
    const superseded = call.signal.aborted
      ? undefined
      : await failedOrPending(run, attempt, owner, error);
    throw superseded ?? error;
  } finally {
    timedOut.stop();
  }
  // stored masked (or a marker: the call happened); the step gets the answer as it is
  const stored = await storedResultOf(run, answer);
  const isCompleted = () => repository.markCompleted(run.key, owner, stored, endExpiryOf(run));
  // both reached the other system (#795): the step fails, never goes on as if all were well
  if (!(await fencedEnd(run, attempt, isCompleted))) {
    // the other system answered: a call joined to this one shares the error, never sends again
    run.answer.isAnswered = true;
    throw await supersededErrorOf(run, attempt);
  }
  told(run, OutboundCallEventOutcome.Sent, [OutboundCallStatus.Completed, attempt]);
  return outcomeOf(run, OutboundCallSendStatus.Sent, answer, attempt);
}
