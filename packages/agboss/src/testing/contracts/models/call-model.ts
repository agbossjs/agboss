import {
  fenced,
  type FencedKeyFacts,
  type FencingState,
  type ModelCall,
  type ModelStep,
} from "./lease-model.js";

/**
 * The outbound-call part of the sequential model (#533 items 2 and 5): one intent per identity
 * (the step's key, or the tenant, name and business key), every operation fenced first — a refusal
 * is `"fenced"` — then the compare-and-sets of the contract: `saveIfAbsent` once, `markPending`
 * only from the state as read, `markCompleted` / `markFailed` only by a pending attempt's owner.
 */

/** A fenced key of an intent: its lease and mark, and the identity of its row. */
export interface CallKeyFacts extends FencedKeyFacts {
  readonly identity: string;
  readonly leaseExecutionId: string;
}

/** What `findByKey` answers, as the model compares it. */
export type FoundCall = Pick<ModelCall, "status" | "attempt" | "attemptOwner" | "token"> | null;

/** The state a caller read: what `markPending` compares. */
export interface ReadCall {
  readonly status: ModelCall["status"];
  readonly attempt: number;
  readonly attemptOwner: string;
}

const withCall = (state: FencingState, identity: string, call: ModelCall): FencingState => ({
  ...state,
  calls: { ...state.calls, [identity]: call },
});

/** `findByKey`: the intent as stored, or none; `fenced` when the key's lease refuses it. */
export function callFound(
  state: FencingState,
  key: CallKeyFacts,
  now: number,
): ModelStep<FoundCall | "fenced"> {
  const passed = fenced(state, key, now);
  if (passed === undefined) return { state, answer: "fenced" };
  const call = passed.calls[key.identity];
  if (call === undefined) return { state: passed, answer: null };
  const { status, attempt, attemptOwner, token } = call;
  return { state: passed, answer: { status, attempt, attemptOwner, token } };
}

/** `saveIfAbsent`: the first attempt recorded pending, `false` when the identity has an intent. */
export function callSaved(
  state: FencingState,
  key: CallKeyFacts,
  attemptOwner: string,
  now: number,
): ModelStep<boolean | "fenced"> {
  const passed = fenced(state, key, now);
  if (passed === undefined) return { state, answer: "fenced" };
  if (passed.calls[key.identity] !== undefined) return { state: passed, answer: false };
  const call: ModelCall = {
    status: "pending",
    attempt: 1,
    attemptOwner,
    token: key.token,
    leaseExecutionId: key.leaseExecutionId,
  };
  return { state: withCall(passed, key.identity, call), answer: true };
}

/** `markPending`: the next attempt claimed, only while the intent is as `expected`. */
export function callClaimed(
  state: FencingState,
  key: CallKeyFacts,
  expected: ReadCall,
  claim: { readonly attempt: number; readonly attemptOwner: string },
  now: number,
): ModelStep<boolean | "fenced"> {
  const passed = fenced(state, key, now);
  if (passed === undefined) return { state, answer: "fenced" };
  const call = passed.calls[key.identity];
  const isAsRead =
    call?.status === expected.status &&
    call.attempt === expected.attempt &&
    call.attemptOwner === expected.attemptOwner;
  if (!isAsRead) return { state: passed, answer: false };
  const claimed: ModelCall = {
    status: "pending",
    ...claim,
    token: key.token,
    leaseExecutionId: key.leaseExecutionId,
  };
  return { state: withCall(passed, key.identity, claimed), answer: true };
}

/** `markCompleted` / `markFailed`: the attempt ended, only by the owner of a pending one. */
export function callEnded(
  state: FencingState,
  key: CallKeyFacts,
  attemptOwner: string,
  status: "completed" | "failed",
  now: number,
): ModelStep<boolean | "fenced"> {
  const passed = fenced(state, key, now);
  if (passed === undefined) return { state, answer: "fenced" };
  const call = passed.calls[key.identity];
  if (call?.status !== "pending" || call.attemptOwner !== attemptOwner)
    return { state: passed, answer: false };
  const ended: ModelCall = {
    ...call,
    status,
    token: key.token,
    leaseExecutionId: key.leaseExecutionId,
  };
  return { state: withCall(passed, key.identity, ended), answer: true };
}
