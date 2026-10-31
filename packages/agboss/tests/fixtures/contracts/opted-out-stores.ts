/**
 * #543 — stores that opt out of the atomic lease check: one that really reads the lease outside
 * its write's transaction (check, then write — what the opt-out says), beside the atomic one with
 * the flag stuck on (`UncheckedCalls`, broken-fencing-stores.ts).
 */
import { LeaseCheck } from "../../../src/infrastructure/execution-lease.repository.js";
import { CheckThenWriteEffects } from "./broken-fencing-stores.js";

/** Check, then write, and saying so: the opt-out's honest store. */
export class OptedOutCheckThenWriteEffects extends CheckThenWriteEffects {
  static override readonly backend: string | undefined = "redis";
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}
