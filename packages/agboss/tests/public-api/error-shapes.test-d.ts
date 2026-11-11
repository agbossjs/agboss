/**
 * #890 AC3, at compile time: a static code is its literal (a switch on `error.code` narrows), and
 * the reasons of an unreconciled call and of an unstored result are closed sets of codes.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  BusinessKeyConflictError,
  ExecutionFencedError,
  OutboundCallResultNotStoredError,
  OutboundCallUnreconciledError,
  SyncWorkRequiredError,
  ThreadIdsExhaustedError,
  type OutboundCallResultNotStoredReason,
  type OutboundCallUnreconciledReason,
} from "../../src/index.js";

describe("#890 AC3: literal codes and closed reasons", () => {
  it("AC3: a static code is its literal, so a switch on error.code narrows", () => {
    expectTypeOf(
      BusinessKeyConflictError.code,
    ).toEqualTypeOf<"fenced-effect.business-key-conflict">();
    expectTypeOf(ThreadIdsExhaustedError.code).toEqualTypeOf<"run.thread-ids-exhausted">();
    expectTypeOf(SyncWorkRequiredError.code).toEqualTypeOf<"fenced-effect.sync-work-required">();
    expectTypeOf(OutboundCallUnreconciledError.code).toEqualTypeOf<"outbound-call.unreconciled">();
    expectTypeOf(ExecutionFencedError.code).toEqualTypeOf<"execution.lease-lost.fenced">();
  });

  it("AC3: an unreconciled call's and an unstored result's reason are closed sets of codes", () => {
    expectTypeOf<OutboundCallUnreconciledError["reason"]>().toEqualTypeOf<
      "reconcile.unknown" | "reconcile.threw" | "reconcile.no-verdict" | "key-retention.passed"
    >();
    expectTypeOf<OutboundCallUnreconciledReason>().toEqualTypeOf<
      OutboundCallUnreconciledError["reason"]
    >();
    expectTypeOf<OutboundCallResultNotStoredError["reason"]>().toEqualTypeOf<
      | "outbound-call.payload-too-large"
      | "outbound-call.unmasked"
      | "outbound-call.result-unstorable"
    >();
    expectTypeOf<OutboundCallResultNotStoredReason>().toEqualTypeOf<
      OutboundCallResultNotStoredError["reason"]
    >();
  });
});
