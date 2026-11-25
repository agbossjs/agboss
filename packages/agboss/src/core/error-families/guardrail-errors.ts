import { defineFamily, type FamilyConstructor, type PaidErrorVariant } from "./family.js";
// a paid family: its errors read their spend through the report finops/cost-report sets
import "../../finops/cost-report.js";

/** The kinds of `GuardrailError`: `switch (error.kind)` is exhaustive. */
export enum GuardrailErrorKind {
  Blocked = "blocked",
  Failed = "failed",
}

/** A guardrail stopped a step (`Blocked`) or could not decide (`Failed`). */
export type GuardrailError = GuardrailError.Blocked | GuardrailError.Failed;

/** The variants of `GuardrailError`, each with the facts it carries. */
export declare namespace GuardrailError {
  /** A guardrail blocked the content. */
  export type Blocked = PaidErrorVariant<GuardrailErrorKind.Blocked, "guardrail.blocked"> & {
    readonly guardrail: string;
    readonly refusal: string;
    /** The setting that decided: `guardrails.<name>.threshold`. */
    readonly key?: string | undefined;
    readonly probability: number;
    readonly threshold: number;
  };
  /** A guardrail could not decide. */
  export type Failed = PaidErrorVariant<GuardrailErrorKind.Failed, "guardrail.failed"> & {
    readonly guardrail: string;
  };
}

/** `GuardrailError`: the family's constructor and its variants'. */
export const GuardrailError: FamilyConstructor<
  GuardrailError,
  { Blocked: GuardrailError.Blocked; Failed: GuardrailError.Failed },
  { Blocked: "key" }
> = defineFamily({
  name: "GuardrailError",
  code: "guardrail",
  kinds: GuardrailErrorKind,
  paid: true,
  variants: {
    Blocked: [
      (f: { guardrail?: string; refusal?: string }) =>
        `Guardrail "${f.guardrail ?? ""}" blocked the execution: ${f.refusal ?? ""}`,
      undefined,
      {
        keep: (f: { guardrail?: string }) => ({ key: `guardrails.${f.guardrail ?? ""}.threshold` }),
        needs: ["guardrail"],
        plain: "a guardrail blocked the content",
      },
    ],
    Failed: ["a guardrail could not decide"],
  },
});

/** The kinds of `PiiError`: `switch (error.kind)` is exhaustive. */
export enum PiiErrorKind {
  Refused = "refused",
  DetectionFailed = "detection-failed",
}

/** A PII policy refused a value (`Refused`) or its detector failed (`DetectionFailed`). */
export type PiiError = PiiError.Refused | PiiError.DetectionFailed;

/** The variants of `PiiError`, each with the facts it carries. */
export declare namespace PiiError {
  /** A PII policy refused the content. */
  export type Refused = PaidErrorVariant<PiiErrorKind.Refused, "pii.refused"> & {
    /** The kind that matched (`card-number`), or a project detector's label. */
    readonly piiKind: string;
    readonly refusal: string;
  };
  /** A PII detector failed. */
  export type DetectionFailed = PaidErrorVariant<
    PiiErrorKind.DetectionFailed,
    "pii.detection-failed"
  >;
}

/** `PiiError`: the family's constructor and its variants'. */
export const PiiError: FamilyConstructor<
  PiiError,
  { Refused: PiiError.Refused; DetectionFailed: PiiError.DetectionFailed }
> = defineFamily({
  name: "PiiError",
  code: "pii",
  kinds: PiiErrorKind,
  paid: true,
  variants: {
    Refused: [
      (f: { piiKind?: string; refusal?: string }) =>
        `PII of kind ${f.piiKind ?? ""} refused the message: ${f.refusal ?? ""}`,
      undefined,
      { needs: ["piiKind"], plain: "a PII policy refused the content" },
    ],
    DetectionFailed: ["a PII detector failed"],
  },
});
