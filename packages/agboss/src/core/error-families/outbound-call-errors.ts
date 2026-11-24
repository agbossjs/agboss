import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import type { Bytes } from "../../units/index.js";

/** The kinds of `OutboundCallError`: `switch (error.kind)` is exhaustive. */
export enum OutboundCallErrorKind {
  InFlight = "in-flight",
  Superseded = "superseded",
  Unreconciled = "unreconciled",
  ResultNotStored = "result-not-stored",
  PayloadTooLarge = "payload-too-large",
  Unmasked = "unmasked",
  InvalidRecovery = "invalid-recovery",
}

/** An outbound call to an external system was refused, is in flight, or cannot be settled. */
export type OutboundCallError =
  | OutboundCallError.InFlight
  | OutboundCallError.Superseded
  | OutboundCallError.Unreconciled
  | OutboundCallError.ResultNotStored
  | OutboundCallError.PayloadTooLarge
  | OutboundCallError.Unmasked
  | OutboundCallError.InvalidRecovery;

/** The variants of `OutboundCallError`, each with the facts it carries. */
export declare namespace OutboundCallError {
  /** The call is in flight on another pass. */
  export type InFlight = ErrorVariant<OutboundCallErrorKind.InFlight, "outbound-call.in-flight"> & {
    readonly call: string;
    readonly target: string;
    readonly operation: string;
  };
  /** The call was superseded by a newer pass. */
  export type Superseded = ErrorVariant<
    OutboundCallErrorKind.Superseded,
    "outbound-call.superseded"
  > & { readonly call: string; readonly target: string; readonly operation: string } & {
    /** The key both attempts went with (a business key's by its handle). */
    readonly idempotencyKey: string;
    /** The attempt that was answered too late. */
    readonly attempt: number;
    /** The newer attempt that took the intent over; `undefined` when the intent could not be read. */
    readonly supersededBy: number | undefined;
  };
  /** The call's outcome is not known and has to be reconciled. */
  export type Unreconciled = ErrorVariant<
    OutboundCallErrorKind.Unreconciled,
    "outbound-call.unreconciled"
  > & { readonly call: string; readonly target: string; readonly operation: string } & {
    readonly idempotencyKey: string;
    /** Why the call could not be settled: a closed set of codes. */
    readonly reason:
      "reconcile.unknown" | "reconcile.threw" | "reconcile.no-verdict" | "key-retention.passed";
    /** What was said, masked: the lookup's own reason, the thrown error's message, the key's age. */
    readonly detail: string;
  };
  /** The call's result was not stored. */
  export type ResultNotStored = ErrorVariant<
    OutboundCallErrorKind.ResultNotStored,
    "outbound-call.result-not-stored"
  > & { readonly call: string; readonly target: string; readonly operation: string } & {
    /** The code of what kept the result from being stored: a closed set. */
    readonly reason:
      | "outbound-call.payload-too-large"
      | "outbound-call.unmasked"
      | "outbound-call.result-unstorable";
  };
  /** The call's payload is over the size a store keeps. */
  export type PayloadTooLarge = ErrorVariant<
    OutboundCallErrorKind.PayloadTooLarge,
    "outbound-call.payload-too-large"
  > & {
    /** The call's `name`. */
    readonly call: string;
    /** Which part of the call is too large. */
    readonly part: "request" | "result";
    readonly size: Bytes;
    readonly maxPayloadSize: Bytes;
  };
  /** The call's payload was not masked. */
  export type Unmasked = ErrorVariant<OutboundCallErrorKind.Unmasked, "outbound-call.unmasked"> & {
    /** The call's `name`. */
    readonly call: string;
  };
  /** The call's recovery answer is not valid. */
  export type InvalidRecovery = ErrorVariant<
    OutboundCallErrorKind.InvalidRecovery,
    "outbound-call.invalid-recovery"
  > & {
    /** The call's `name`. */
    readonly call: string;
    /** What is wrong with it. */
    readonly problem: string;
  };
}

/** `OutboundCallError`: the family's constructor and its variants'. */
export const OutboundCallError: FamilyConstructor<
  OutboundCallError,
  {
    InFlight: OutboundCallError.InFlight;
    Superseded: OutboundCallError.Superseded;
    Unreconciled: OutboundCallError.Unreconciled;
    ResultNotStored: OutboundCallError.ResultNotStored;
    PayloadTooLarge: OutboundCallError.PayloadTooLarge;
    Unmasked: OutboundCallError.Unmasked;
    InvalidRecovery: OutboundCallError.InvalidRecovery;
  }
> = defineFamily({
  name: "OutboundCallError",
  code: "outbound-call",
  kinds: OutboundCallErrorKind,
  variants: {
    InFlight: ["the call is in flight on another pass"],
    Superseded: ["the call was superseded by a newer pass"],
    Unreconciled: ["the call's outcome is not known and has to be reconciled"],
    ResultNotStored: ["the call's result was not stored"],
    PayloadTooLarge: ["the call's payload is over the size a store keeps"],
    Unmasked: ["the call's payload was not masked"],
    InvalidRecovery: ["the call's recovery answer is not valid"],
  },
});
