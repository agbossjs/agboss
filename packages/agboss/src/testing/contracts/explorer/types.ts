import type { ExecutionLeaseRepository } from "../../../infrastructure/execution-lease.repository.js";
import type { FencedEffectRepository } from "../../../infrastructure/fenced-effect.repository.js";
import type { OutboundCallRepository } from "../../../infrastructure/outbound-call.repository.js";
import { seconds, type Milliseconds } from "../../../units/index.js";
import type { ClockSkew } from "../../clock-skew.js";
import type { FencedEffectBusinessRows } from "../fenced-effect-data.js";

/**
 * The interleaving explorer (#533 item 1): a deterministic scheduler over the fencing stores. N
 * simulated instances take, renew, yield, reclaim, release and finish one tree's lease, ask
 * `leaseStateOf`, write fenced effects and move an outbound call through its protocol; the
 * scheduler picks whose operation runs next, holds every other one before the store until it
 * does, and checks the invariants after each step. These are its words.
 */

/** The lease every simulated instance asks for. */
export const EXPLORED_LEASE: Milliseconds = seconds(30);

/** The tenant of every explored tree. */
export const EXPLORED_TENANT = "default";

/** What the explorer checks after every step. */
export enum ExplorerInvariant {
  /** At most one instance trusts the tree's lease at any moment, and each epoch is granted once. */
  OneLiveHolder = "one-live-holder",
  /** No write (or fenced read) is accepted at a superseded, released, finished or expired token. */
  NoStaleWrite = "no-stale-write",
  /** One step's fenced effect writes its business row once, whoever runs it. */
  OneEffectPerKey = "one-effect-per-key",
  /** The other system is charged at most once per business key. */
  OneSendPerBusinessKey = "one-send-per-business-key",
  /** No lease of finished work is granted again: no Takeover row for it. */
  NoTakeoverOfFinishedWork = "no-takeover-of-finished-work",
  /** A store operation threw something else than the fence's refusal. */
  StoreError = "store-error",
}

/** One broken invariant. */
export interface ExplorerViolation {
  readonly invariant: ExplorerInvariant;
  readonly message: string;
}

/** The lease operations of one instance on one tree. */
export enum LeaseOperation {
  Acquire = "acquire",
  Renew = "renew",
  Yield = "yield",
  Reclaim = "reclaim",
  Release = "release",
  Finish = "finish",
}

/** How far the time moves: a renewal's beat, or to the next lease's end (1 ms before, or at it). */
export enum TimeStep {
  Beat = "beat",
  BeforeEnd = "before-end",
  End = "end",
}

/** One choice of the scheduler. */
export type ExplorerAction =
  | {
      readonly kind: "lease";
      readonly operation: LeaseOperation;
      readonly instance: number;
      readonly tree: string;
    }
  /** `leaseStateOf` of the tree's current epoch, asked by `instance`. */
  | { readonly kind: "check"; readonly instance: number; readonly tree: string }
  /** The step's fenced effect, at the last token `instance` held. */
  | { readonly kind: "write"; readonly instance: number; readonly tree: string }
  /** The next operation of `instance`'s outbound call on `tree`. */
  | { readonly kind: "call"; readonly instance: number; readonly tree: string }
  /** The other system takes `instance`'s request in flight: charged, or declined. */
  | {
      readonly kind: "deliver";
      readonly instance: number;
      readonly tree: string;
      readonly isAccepted: boolean;
    }
  | { readonly kind: "time"; readonly step: TimeStep };

/** One instance's stores of the explored backend: the leases, and what else the world uses. */
export interface ExplorerStores {
  readonly leases: ExecutionLeaseRepository;
  readonly effects?: FencedEffectRepository<unknown>;
  readonly rows?: FencedEffectBusinessRows<unknown>;
  readonly calls?: OutboundCallRepository;
}

/** What a world's instances do. */
export enum ExplorerWorldKind {
  /** Every lease operation and `leaseStateOf`. */
  Lease = "lease",
  /** Takes, renewals and releases with the step's fenced effect. */
  FencedEffect = "fenced-effect",
  /** Takes and renewals with an outbound call through its protocol. */
  OutboundCall = "outbound-call",
}

/** One explored world: who runs, on which trees, with which clocks. */
export interface ExplorerWorld {
  readonly kind: ExplorerWorldKind;
  /** How many simulated instances. */
  readonly instances: number;
  /** The tree each instance works on, by instance (1-based): one tree is a hand-over, two a business key. */
  readonly treeOf: (instance: number) => string;
  /** How each instance's own clock is off (the store keeps the run's time). */
  readonly skewOf: (instance: number) => ClockSkew;
}

/** The business key every explored call sends under. */
export const EXPLORED_BUSINESS_KEY = "order:1";
