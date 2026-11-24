import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import type { Bytes } from "../../units/index.js";
import type { DtoIssue } from "../../dto/errors.js";
import type { KeyTextRule } from "../errors.js";
export { OutboundCallError, OutboundCallErrorKind } from "./outbound-call-errors.js";

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
  > & {
    /** The effect's or the call's name. */
    readonly effect: string;
    /** The business key's handle, when one could be made: never the key. */
    readonly businessKeyHash?: string | undefined;
  };
  /** The business key is not a key. */
  export type InvalidKey = ErrorVariant<
    IdempotencyErrorKind.InvalidKey,
    "idempotency.invalid-key"
  > & {
    /** The effect's or the call's name, when the key was one of an effect. */
    readonly effect?: string | undefined;
    /** The rule of a key's text it breaks, when it is one: never the key. */
    readonly rule?: KeyTextRule | undefined;
  };
  /** The effect's name is not valid. */
  export type InvalidName = ErrorVariant<
    IdempotencyErrorKind.InvalidName,
    "idempotency.invalid-name"
  > & {
    /** How many characters the name has: never the name. */
    readonly length: number;
  };
  /** The effect needs a fingerprint. */
  export type FingerprintRequired = ErrorVariant<
    IdempotencyErrorKind.FingerprintRequired,
    "idempotency.fingerprint-required"
  > & {
    readonly effect: string;
    /** `"missing"`: neither a fingerprint nor `withoutFingerprint`; `"contradictory"`: both. */
    readonly reason: "missing" | "contradictory";
  };
  /** The fingerprint is not JSON. */
  export type FingerprintNotJson = ErrorVariant<
    IdempotencyErrorKind.FingerprintNotJson,
    "idempotency.fingerprint-not-json"
  > & {
    readonly effect: string;
    /** Where in the fingerprint (`$.order.placedAt`). */
    readonly path: string;
    /** What is there instead of plain JSON (`a Date`), never its value. */
    readonly reason: string;
  };
  /** The idempotency secret is missing. */
  export type SecretKeyMissing = ErrorVariant<
    IdempotencyErrorKind.SecretKeyMissing,
    "idempotency.secret-key-missing"
  > & {
    /** The effect (or call) whose fingerprint needed the key. */
    readonly effect: string;
  };
  /** The effect's result is over the size a store keeps. */
  export type ResultTooLarge = ErrorVariant<
    IdempotencyErrorKind.ResultTooLarge,
    "idempotency.result-too-large"
  > & { readonly effect: string; readonly size: Bytes; readonly maxResultSize: Bytes };
  /** The effect's store is not the one the execution runs on. */
  export type StoreMismatch = ErrorVariant<
    IdempotencyErrorKind.StoreMismatch,
    "idempotency.store-mismatch"
  > & {
    readonly fencedEffectRepository: string;
    readonly leaseRepository: string;
    /** The lease store the effect's store reads its leases from. */
    readonly expectedLeaseRepository: string;
  };
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
