import {
  IdempotencyKeyConflictError,
  fencedKeyIdentityOf,
} from "../infrastructure/fenced-effect-key.js";
import { OutboundCallEventOutcome } from "../infrastructure/execution-lease-event.repository.js";
import type { FencedEffectKey } from "../infrastructure/fenced-effect.repository.js";
import { OutboundCallStatus } from "../infrastructure/outbound-call.repository.js";
import { outcomeOf, told, type CallRun, type LiveCall } from "./outbound-call-parts.js";
import { OutboundCallOutcomeStatus, type OutboundCallOutcome } from "./outbound-calls.js";

/**
 * The calls this instance is making now (#505, #508): a second call of one key — two tool calls,
 * two branches, two executions under one business key — joins the first, never reconciles or
 * resends it; another fingerprint under that business key is a conflict, never joined. A step
 * aborted (a lost lease, a cancel, its timeout) owns its call no more.
 */

/** What a call of this instance is known by while it is made: its key's row (a business key's). */
const liveKeyOf = (key: FencedEffectKey): string =>
  `${key.tenantId}\u0000${fencedKeyIdentityOf(key)}`;

/**
 * The outcome of the call this instance is making now: shared when it succeeded, its error when
 * the other system answered with one (#508); anything else of the first call's own — its hand-over,
 * its cancel — is not this call's: it makes the call itself, under its own frame.
 */
async function joinedTo<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  joined: LiveCall,
  make: () => Promise<OutboundCallOutcome<TResult>>,
): Promise<OutboundCallOutcome<TResult>> {
  const { key } = run;
  if (key.businessKey !== undefined && joined.fingerprint !== key.fingerprint)
    throw new IdempotencyKeyConflictError({ name: key.name, businessKeyHash: key.businessKeyHash });
  const first = await sharedOf(run, joined);
  if (first === undefined) return joinedOrMade(run, make);
  told(run, OutboundCallEventOutcome.Joined, [OutboundCallStatus.Completed, first.attempt]);
  return outcomeOf(run, OutboundCallOutcomeStatus.Joined, first.result, first.attempt);
}

/**
 * What the first call shares with `run`, which waits on it: its outcome, its error when the other
 * system answered with it (whatever was thrown), else `undefined`; `run`'s abort rejects the wait,
 * its listener removed once it ends.
 */
async function sharedOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  joined: LiveCall,
): Promise<OutboundCallOutcome<unknown> | undefined> {
  const { signal } = run.frame.execution;
  signal.throwIfAborted();
  let stop = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
  const shared = joined.outcome.catch((error: unknown) => {
    if (joined.answer.isAnswered) throw error;
    return undefined;
  });
  try {
    return await Promise.race([shared, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** The call of `run` joined when this instance is making it now; else made by `make`, live meanwhile. */
export async function joinedOrMade<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  make: () => Promise<OutboundCallOutcome<TResult>>,
): Promise<OutboundCallOutcome<TResult>> {
  const { parts, key } = run;
  const live = liveKeyOf(key);
  const joined = parts.live.get(live);
  if (joined !== undefined) return joinedTo(run, joined, make);
  const call = { fingerprint: key.fingerprint, outcome: make(), answer: run.answer };
  parts.live.set(live, call);
  const { signal } = run.frame.execution;
  const leave = (): void => {
    if (parts.live.get(live) === call) parts.live.delete(live);
  };
  signal.addEventListener("abort", leave, { once: true });
  try {
    return await call.outcome;
  } finally {
    signal.removeEventListener("abort", leave);
    leave();
  }
}

/**
 * `work` as the owner of an attempt (#508): live in this instance from before its intent is recorded
 * or claimed until the attempt ends — a failure and a hand-over too — so no caller of this instance
 * ever takes it for gone; its lease is released only once it settled, so no other instance does.
 */
export async function owning<TRequest, TResult, TValue>(
  run: CallRun<TRequest, TResult>,
  owner: string,
  work: () => Promise<TValue>,
): Promise<TValue> {
  const { owners } = run.parts;
  owners.add(owner);
  try {
    const attempt = work();
    // its lease stays open until it settled (#508): no other instance takes it for gone
    run.frame.execution.lease?.keepWhile?.(attempt, run.parts.settings.attemptTimeout);
    return await attempt;
  } finally {
    owners.delete(owner);
  }
}
