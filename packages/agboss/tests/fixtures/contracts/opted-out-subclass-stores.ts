/**
 * #543 acceptance — an opt-out that comes from the class chain: a store inheriting its parent's
 * `LeaseCheck.WithoutDoubleChargeProtection` without restating it is opted out (the gate and assembly
 * read the class's `leaseCheck` the same way), and a subclass that restates `LeaseCheck.Atomic` over
 * an opted-out parent is an atomic store again — its author's latest word.
 */
import { LeaseCheck } from "../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";

/** The parent that opts out. */
export class OptedOutParentCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = "redis";
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}

/** Opted out only through its parent: it says nothing itself. */
export class InheritedOptOutCalls extends OptedOutParentCalls {}

/** An opted-out parent's subclass that restates the atomic check, on the core's in-memory backend. */
export class RestatedAtomicCalls extends OptedOutParentCalls {
  static override readonly backend: string | undefined = InMemoryOutboundCallRepository.backend;
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.Atomic;
}
