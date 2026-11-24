/**
 * #890 AC3, at compile time: a static code is its literal (a switch on `error.code` narrows), and
 * the reasons of an unreconciled call and of an unstored result are closed sets of codes.
 */
import type {
  IdempotencyError,
  OutboundCallError,
} from "../../src/core/error-families/effect-errors.js";
import { describe, expectTypeOf, it } from "vitest";
import {
  ExecutionFencedError,
  SyncWorkRequiredError,
  ThreadIdsExhaustedError,
} from "../../src/index.js";
import type {
  OutboundCallResultNotStoredReason,
  OutboundCallUnreconciledReason,
} from "../../src/app/outbound-call-types.js";

describe("#890 AC3: literal codes and closed reasons", () => {
  it("AC3: a static code is its literal, so a switch on error.code narrows", () => {
    // a family's variants carry their literal on the instance, not on a static
    expectTypeOf<
      IdempotencyError.KeyConflict["code"]
    >().toEqualTypeOf<"idempotency.key-conflict">();
    expectTypeOf(ThreadIdsExhaustedError.code).toEqualTypeOf<"run.thread-ids-exhausted">();
    expectTypeOf(SyncWorkRequiredError.code).toEqualTypeOf<"fenced-effect.sync-work-required">();
    expectTypeOf<
      OutboundCallError.Unreconciled["code"]
    >().toEqualTypeOf<"outbound-call.unreconciled">();
    expectTypeOf(ExecutionFencedError.code).toEqualTypeOf<"execution.lease-lost.fenced">();
  });

  it("AC3: an unreconciled call's and an unstored result's reason are closed sets of codes", () => {
    expectTypeOf<OutboundCallError.Unreconciled["reason"]>().toEqualTypeOf<
      "reconcile.unknown" | "reconcile.threw" | "reconcile.no-verdict" | "key-retention.passed"
    >();
    expectTypeOf<OutboundCallUnreconciledReason>().toEqualTypeOf<
      OutboundCallError.Unreconciled["reason"]
    >();
    expectTypeOf<OutboundCallError.ResultNotStored["reason"]>().toEqualTypeOf<
      | "outbound-call.payload-too-large"
      | "outbound-call.unmasked"
      | "outbound-call.result-unstorable"
    >();
    expectTypeOf<OutboundCallResultNotStoredReason>().toEqualTypeOf<
      OutboundCallError.ResultNotStored["reason"]
    >();
  });
});
