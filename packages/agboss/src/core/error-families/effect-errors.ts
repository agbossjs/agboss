import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import type { Bytes } from "../../units/index.js";
import type { DtoIssue } from "../../dto/errors.js";

/** The kinds of `IdempotencyError`: `switch (error.kind)` is exhaustive. */
export enum IdempotencyErrorKind {
  KeyConflict = "key-conflict",
  InvalidKey = "invalid-key",
  InvalidName = "invalid-name",
  FingerprintRequired = "fingerprint-required",
  FingerprintNotJson = "fingerprint-not-json",
  SecretKeyMissing = "secret-key-missing",
  ResultTooLarge = "result-too-large",
  StoreMismatch = "store-mismatch",
  OutsideTransaction = "outside-transaction",
  NestedRunOnce = "nested-run-once",
  ExternalCallInTransaction = "external-call-in-transaction",
}

/** A once-only effect (`Idempotency.runOnce`, a fenced effect) was refused or misused. */
export type IdempotencyError =
  | IdempotencyError.KeyConflict
  | IdempotencyError.InvalidKey
  | IdempotencyError.InvalidName
  | IdempotencyError.FingerprintRequired
  | IdempotencyError.FingerprintNotJson
  | IdempotencyError.SecretKeyMissing
  | IdempotencyError.ResultTooLarge
  | IdempotencyError.StoreMismatch
  | IdempotencyError.OutsideTransaction
  | IdempotencyError.NestedRunOnce
  | IdempotencyError.ExternalCallInTransaction;

/** The variants of `IdempotencyError`, each with the facts it carries. */
export declare namespace IdempotencyError {
  /** The business key is already settled with another fingerprint. */
  export type KeyConflict = ErrorVariant<
    IdempotencyErrorKind.KeyConflict,
    "idempotency.key-conflict"
  >;
  /** The business key is not a key. */
  export type InvalidKey = ErrorVariant<IdempotencyErrorKind.InvalidKey, "idempotency.invalid-key">;
  /** The effect's name is not valid. */
  export type InvalidName = ErrorVariant<
    IdempotencyErrorKind.InvalidName,
    "idempotency.invalid-name"
  >;
  /** The effect needs a fingerprint. */
  export type FingerprintRequired = ErrorVariant<
    IdempotencyErrorKind.FingerprintRequired,
    "idempotency.fingerprint-required"
  >;
  /** The fingerprint is not JSON. */
  export type FingerprintNotJson = ErrorVariant<
    IdempotencyErrorKind.FingerprintNotJson,
    "idempotency.fingerprint-not-json"
  >;
  /** The idempotency secret is missing. */
  export type SecretKeyMissing = ErrorVariant<
    IdempotencyErrorKind.SecretKeyMissing,
    "idempotency.secret-key-missing"
  >;
  /** The effect's result is over the size a store keeps. */
  export type ResultTooLarge = ErrorVariant<
    IdempotencyErrorKind.ResultTooLarge,
    "idempotency.result-too-large"
  > & { readonly size: Bytes; readonly maxResultSize: Bytes };
  /** The effect's store is not the one the execution runs on. */
  export type StoreMismatch = ErrorVariant<
    IdempotencyErrorKind.StoreMismatch,
    "idempotency.store-mismatch"
  >;
  /** The effect needs a transaction and has none. */
  export type OutsideTransaction = ErrorVariant<
    IdempotencyErrorKind.OutsideTransaction,
    "idempotency.outside-transaction"
  >;
  /** RunOnce was called inside a runOnce. */
  export type NestedRunOnce = ErrorVariant<
    IdempotencyErrorKind.NestedRunOnce,
    "idempotency.nested-run-once"
  >;
  /** An external call was made inside a transaction. */
  export type ExternalCallInTransaction = ErrorVariant<
    IdempotencyErrorKind.ExternalCallInTransaction,
    "idempotency.external-call-in-transaction"
  >;
}

/** `IdempotencyError`: the family's constructor and its variants'. */
export const IdempotencyError: FamilyConstructor<
  IdempotencyError,
  {
    KeyConflict: IdempotencyError.KeyConflict;
    InvalidKey: IdempotencyError.InvalidKey;
    InvalidName: IdempotencyError.InvalidName;
    FingerprintRequired: IdempotencyError.FingerprintRequired;
    FingerprintNotJson: IdempotencyError.FingerprintNotJson;
    SecretKeyMissing: IdempotencyError.SecretKeyMissing;
    ResultTooLarge: IdempotencyError.ResultTooLarge;
    StoreMismatch: IdempotencyError.StoreMismatch;
    OutsideTransaction: IdempotencyError.OutsideTransaction;
    NestedRunOnce: IdempotencyError.NestedRunOnce;
    ExternalCallInTransaction: IdempotencyError.ExternalCallInTransaction;
  }
> = defineFamily({
  name: "IdempotencyError",
  code: "idempotency",
  kinds: IdempotencyErrorKind,
  variants: {
    KeyConflict: ["the business key is already settled with another fingerprint"],
    InvalidKey: ["the business key is not a key"],
    InvalidName: ["the effect's name is not valid"],
    FingerprintRequired: ["the effect needs a fingerprint"],
    FingerprintNotJson: ["the fingerprint is not JSON"],
    SecretKeyMissing: ["the idempotency secret is missing"],
    ResultTooLarge: ["the effect's result is over the size a store keeps"],
    StoreMismatch: ["the effect's store is not the one the execution runs on"],
    OutsideTransaction: ["the effect needs a transaction and has none"],
    NestedRunOnce: ["runOnce was called inside a runOnce"],
    ExternalCallInTransaction: ["an external call was made inside a transaction"],
  },
});

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
  export type InFlight = ErrorVariant<OutboundCallErrorKind.InFlight, "outbound-call.in-flight">;
  /** The call was superseded by a newer pass. */
  export type Superseded = ErrorVariant<
    OutboundCallErrorKind.Superseded,
    "outbound-call.superseded"
  >;
  /** The call's outcome is not known and has to be reconciled. */
  export type Unreconciled = ErrorVariant<
    OutboundCallErrorKind.Unreconciled,
    "outbound-call.unreconciled"
  >;
  /** The call's result was not stored. */
  export type ResultNotStored = ErrorVariant<
    OutboundCallErrorKind.ResultNotStored,
    "outbound-call.result-not-stored"
  >;
  /** The call's payload is over the size a store keeps. */
  export type PayloadTooLarge = ErrorVariant<
    OutboundCallErrorKind.PayloadTooLarge,
    "outbound-call.payload-too-large"
  > & { readonly size: Bytes; readonly maxPayloadSize: Bytes };
  /** The call's payload was not masked. */
  export type Unmasked = ErrorVariant<OutboundCallErrorKind.Unmasked, "outbound-call.unmasked">;
  /** The call's recovery answer is not valid. */
  export type InvalidRecovery = ErrorVariant<
    OutboundCallErrorKind.InvalidRecovery,
    "outbound-call.invalid-recovery"
  >;
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

/** The kinds of `ValidationError`: `switch (error.kind)` is exhaustive. */
export enum ValidationErrorKind {
  DtoInvalid = "dto-invalid",
  TenantRequired = "tenant-required",
}

/** A caller's input is not what the call takes: a payload that is no valid DTO, a call that lacks its `tenantId`. Not a configuration error: it comes from the call, not the declaration. */
export type ValidationError = ValidationError.DtoInvalid | ValidationError.TenantRequired;

/** The variants of `ValidationError`, each with the facts it carries. */
export declare namespace ValidationError {
  /** A payload is not a valid DTO. */
  export type DtoInvalid = ErrorVariant<
    ValidationErrorKind.DtoInvalid,
    "validation.dto-invalid"
  > & { readonly dto: string; readonly issues: readonly DtoIssue[] };
  /** The call needs a tenantId. */
  export type TenantRequired = ErrorVariant<
    ValidationErrorKind.TenantRequired,
    "validation.tenant-required"
  > & { readonly operation: string };
}

/** `ValidationError`: the family's constructor and its variants'. */
export const ValidationError: FamilyConstructor<
  ValidationError,
  { DtoInvalid: ValidationError.DtoInvalid; TenantRequired: ValidationError.TenantRequired }
> = defineFamily({
  name: "ValidationError",
  code: "validation",
  kinds: ValidationErrorKind,
  variants: {
    DtoInvalid: ["a payload is not a valid DTO"],
    TenantRequired: ["the call needs a tenantId"],
  },
});
