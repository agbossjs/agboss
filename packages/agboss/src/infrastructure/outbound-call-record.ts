import type { OutboundCallStatus } from "./outbound-call.repository.js";

/**
 * The records of calls that leave the system (#505): what an intent keeps, as types only — the
 * root import loads no module for them.
 */

/** The error a failed call ended with: names and text only, never a payload. */
export interface OutboundCallFailure {
  readonly name: string;
  /** The code of its class (`static code`, else the class name; `Error` for a plain one). */
  readonly code: string;
  readonly message: string;
}

/** The step that made a call: its join keys. */
export interface OutboundCallStep {
  readonly nodeId: string;
  readonly visitNumber: number;
}

/** What is recorded before a call is sent. */
export interface OutboundCallIntent {
  /** The tree's root: what `app.outboundCallsOf` finds the call by. */
  readonly rootExecutionId: string;
  /** The execution whose step made the call. */
  readonly executionId: string;
  /** The workflow of that execution, by `name`: whose PII policies an operator's read masks it by. */
  readonly workflow: string;
  /** What the call goes to, for operators: `"payments"`. */
  readonly target: string;
  /** What it does there: `"charge"`. */
  readonly operation: string;
  /** The key sent with the call: the step's idempotency key and the call's name. */
  readonly idempotencyKey: string;
  /** The request as stored: its JSON, masked by the application's and the workflow's PII policies. */
  readonly request: string;
  /** The attempt about to be sent, from 1. */
  readonly attempt: number;
  /**
   * Who owns that attempt: a random id the caller minted when it claimed it (recorded it, or moved
   * it on with `markPending`). A new attempt is claimed only from the owner the claimer read.
   */
  readonly attemptOwner: string;
  readonly step: OutboundCallStep;
}

/** One call that left the system, as the store keeps it. */
export interface OutboundCallRecord extends OutboundCallIntent {
  readonly tenantId: string;
  /** The call's name (`fencedEffectKeyOf(executionContext, name)`). */
  readonly name: string;
  readonly status: OutboundCallStatus;
  /** The result's JSON, once `Completed`. */
  readonly result?: string;
  /** Why it failed, once `Failed`. */
  readonly failure?: OutboundCallFailure;
  /** The lease token of its last write. */
  readonly token: number;
  /** The execution whose lease made its last write (#508): whose lease tells whether its owner lives. */
  readonly leaseExecutionId: string;
  /** Its business key (#508): one call per tenant, name and business key. */
  readonly businessKey?: string;
  /** What it does, as a hash of its request (#508): another one under its business key conflicts. */
  readonly fingerprint?: string;
  /** When it was recorded (ISO 8601, the application's `Clock`). */
  readonly recordedAt: string;
  /** When it last ended — `Completed` or `Failed`; none while `Pending`. */
  readonly endedAt?: string;
}

/** An intent's state as a caller read it: what `markPending` compares before it moves it. */
/** A new attempt as its caller claims it: its number and the owner id the caller minted. */
export interface OutboundCallClaim {
  readonly attempt: number;
  readonly attemptOwner: string;
}

export interface OutboundCallState {
  readonly status: OutboundCallStatus;
  readonly attempt: number;
  readonly attemptOwner: string;
}
