/**
 * The types the error families are made of (#1325, @beta: type machinery, not a contract): what the
 * signatures of `PauseError.NotPaused`, `LimitError.Budget`, `Result.try` & co. compute with —
 * `ErrorTypes.ErrorVariant`, `ErrorTypes.PaidErrorVariant`, … A type error names them; no code of
 * yours writes them, so their names may change in any release. `TryOutcome`, the type of
 * `Result.try`, stays in the root. Types only: re-exported as the namespace `ErrorTypes`.
 */
export type {
  ErrorVariant,
  FamilyConstructor,
  PaidErrorVariant,
  PaidFacts,
  VariantCommon,
  VariantConstructor,
  VariantConstructors,
  VariantFacts,
  VariantOptions,
} from "../core/error-families/family.js";
export type { ResultFactory } from "../core/result.js";
