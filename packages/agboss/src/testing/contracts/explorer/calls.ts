import { scopeKeyOf } from "../../../app/lease-lost.js";
import { OutboundCallLeaseState } from "../../../infrastructure/execution-lease-event.repository.js";
import type { FencedEffectKey } from "../../../infrastructure/fenced-effect.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRecord,
  type OutboundCallRepository,
  type OutboundCallState,
} from "../../../infrastructure/outbound-call.repository.js";
import type { Observer } from "./observer.js";
import { EXPLORED_BUSINESS_KEY, EXPLORED_TENANT } from "./types.js";

/**
 * One instance's outbound call in the explorer (#533 item 1): the protocol of `OutboundCalls.send`
 * as a state machine, one store operation per step — read the intent; none → record it; completed
 * → replayed; failed → claim the next attempt; pending → in flight while its lease is live
 * (`leaseStateOf`), else reconcile by asking the other system and claim the next attempt when it
 * has none. An attempt is sent only while its sender trusts its lease (the fence), and the other
 * system takes it only before that trust ends (a send that would land later is the provider's G1).
 */

/** Where one call stands. */
export type CallPhase =
  | { readonly phase: "read" }
  | { readonly phase: "save" }
  | { readonly phase: "move"; readonly expected: OutboundCallState }
  | { readonly phase: "check"; readonly found: OutboundCallRecord }
  | { readonly phase: "reconcile"; readonly found: OutboundCallRecord }
  /** In flight under `epoch`: the other system takes it only while that epoch's fence holds. */
  | {
      readonly phase: "flight";
      readonly attempt: number;
      readonly owner: string;
      readonly epoch: number;
    }
  | {
      readonly phase: "end";
      readonly attempt: number;
      readonly owner: string;
      readonly isAccepted: boolean;
    }
  | { readonly phase: "done" };

/** The key of `tree`'s call at `token`, under the explored business key. */
export const callKeyOf = (tree: string, token: number): FencedEffectKey => ({
  scopeKey: scopeKeyOf(EXPLORED_TENANT, tree),
  tenantId: EXPLORED_TENANT,
  leaseExecutionId: tree,
  token,
  idempotencyKey: `${tree}:charge-action:1`,
  name: "charge",
  businessKey: EXPLORED_BUSINESS_KEY,
  fingerprint: "explored-charge",
});

/** What a call step needs: its stores, the observer, the time, its own name and a fresh owner. */
export interface CallStep {
  readonly calls: OutboundCallRepository;
  readonly observer: Observer;
  readonly instance: number;
  readonly tree: string;
  readonly token: number;
  readonly now: number;
  readonly newOwner: () => string;
}

/** What one step did: the next phase and what to print. */
export interface CallOutcome {
  readonly next: CallPhase;
  readonly label: string;
}

/** The phase after a read found `found`. */
function afterRead(step: CallStep, found: OutboundCallRecord | undefined): CallOutcome {
  if (found === undefined) return { next: { phase: "save" }, label: "read: none" };
  const seen = `read: ${found.status}, attempt ${String(found.attempt)} at token ${String(found.token)}`;
  if (found.status === OutboundCallStatus.Completed)
    return { next: { phase: "done" }, label: `${seen} → replayed` };
  if (found.status === OutboundCallStatus.Failed)
    return { next: { phase: "move", expected: stateOf(found) }, label: seen };
  const isUnderThisLease = found.leaseExecutionId === step.tree && found.token === step.token;
  if (isUnderThisLease) return { next: { phase: "reconcile", found }, label: seen };
  return { next: { phase: "check", found }, label: seen };
}

const stateOf = (found: OutboundCallRecord): OutboundCallState => ({
  status: found.status,
  attempt: found.attempt,
  attemptOwner: found.attemptOwner,
});

/** The intent of the first attempt. */
const intentOf = (step: CallStep, owner: string) => ({
  rootExecutionId: step.tree,
  executionId: step.tree,
  workflow: "explored-workflow",
  target: "payments",
  operation: "charge",
  idempotencyKey: `${EXPLORED_TENANT}:${EXPLORED_BUSINESS_KEY}:charge`,
  request: JSON.stringify({ orderId: "order-1", amountUsd: 10 }),
  attempt: 1,
  attemptOwner: owner,
  step: { nodeId: "charge-action", visitNumber: 1 },
});

/** One fenced store operation of the call, its acceptance told to the observer. */
async function fenced<T>(step: CallStep, what: string, call: Promise<T>): Promise<T> {
  const answer = await call;
  step.observer.accepted(
    `instance-${String(step.instance)}'s ${what}`,
    step.tree,
    step.token,
    step.now,
  );
  return answer;
}

/** A send is made only while its sender trusts its lease (`assertHeld()` right before). */
function sent(step: CallStep, attempt: number, owner: string): CallOutcome {
  if (!step.observer.isTrusting(step.instance, step.tree, step.now))
    return {
      next: { phase: "read" },
      label: `send of attempt ${String(attempt)}: not sent, the fence ended`,
    };
  return {
    next: { phase: "flight", attempt, owner, epoch: step.token },
    label: `sent attempt ${String(attempt)}`,
  };
}

/** The pending intent of a lease that is gone, settled by asking the other system. */
async function reconciled(step: CallStep, found: OutboundCallRecord): Promise<CallOutcome> {
  if ((step.observer.charges.get(EXPLORED_BUSINESS_KEY) ?? 0) === 0)
    return { next: { phase: "move", expected: stateOf(found) }, label: "reconcile: not sent" };
  const isEnded = await fenced(
    step,
    "markCompleted (reconciled)",
    step.calls.markCompleted(callKeyOf(step.tree, step.token), found.attemptOwner, '"paid"'),
  );
  return {
    next: isEnded ? { phase: "done" } : { phase: "read" },
    label: `reconcile: charged → ${String(isEnded)}`,
  };
}

/** `leaseStateOf` of the lease a found pending intent was written under. */
async function checked(step: CallStep, found: OutboundCallRecord): Promise<CallOutcome> {
  const lease = {
    tenantId: found.tenantId,
    leaseExecutionId: found.leaseExecutionId,
    token: found.token,
  };
  const state = await step.calls.leaseStateOf(lease);
  if (state === OutboundCallLeaseState.Superseded)
    step.observer.superseded(found.leaseExecutionId, found.token);
  const label = `leaseStateOf(${found.leaseExecutionId} at ${String(found.token)}): ${state}`;
  if (state === OutboundCallLeaseState.Live)
    return { next: { phase: "read" }, label: `${label} → in flight` };
  return { next: { phase: "reconcile", found }, label };
}

/** The attempt `owner` claimed, recorded or moved on. */
async function claimed(step: CallStep, phase: CallPhase): Promise<CallOutcome> {
  const key = callKeyOf(step.tree, step.token);
  const owner = step.newOwner();
  if (phase.phase === "save") {
    const isSaved = await fenced(
      step,
      "saveIfAbsent",
      step.calls.saveIfAbsent(key, intentOf(step, owner)),
    );
    return isSaved
      ? sent(step, 1, owner)
      : { next: { phase: "read" }, label: "saveIfAbsent: false" };
  }
  if (phase.phase !== "move") throw new TypeError(`not a claim: ${phase.phase}`);
  const claim = { attempt: phase.expected.attempt + 1, attemptOwner: owner };
  const isMoved = await fenced(
    step,
    "markPending",
    step.calls.markPending(key, phase.expected, claim),
  );
  return isMoved
    ? sent(step, claim.attempt, owner)
    : { next: { phase: "read" }, label: "markPending: false" };
}

/** The end of an attempt the other system answered. */
async function ended(step: CallStep, owner: string, isAccepted: boolean): Promise<CallOutcome> {
  const key = callKeyOf(step.tree, step.token);
  const isEnded = isAccepted
    ? await fenced(step, "markCompleted", step.calls.markCompleted(key, owner, '"paid"'))
    : await fenced(
        step,
        "markFailed",
        step.calls.markFailed(key, owner, {
          name: "DeclinedError",
          code: "DeclinedError",
          message: "declined",
        }),
      );
  // a declined attempt fails the step, which runs again: it reads the failed intent and claims anew
  const next: CallPhase = isEnded && isAccepted ? { phase: "done" } : { phase: "read" };
  return { next, label: `${isAccepted ? "markCompleted" : "markFailed"} → ${String(isEnded)}` };
}

/** The next operation of a call in `phase`. */
export async function callStep(step: CallStep, phase: CallPhase): Promise<CallOutcome> {
  switch (phase.phase) {
    case "read":
      return afterRead(
        step,
        await fenced(step, "findByKey", step.calls.findByKey(callKeyOf(step.tree, step.token))),
      );
    case "save":
    case "move":
      return claimed(step, phase);
    case "check":
      return checked(step, phase.found);
    case "reconcile":
      return reconciled(step, phase.found);
    case "end":
      return ended(step, phase.owner, phase.isAccepted);
    default:
      throw new TypeError(`no call step in ${phase.phase}`);
  }
}
