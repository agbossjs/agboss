/** The rule codes of `@PiiPolicy` classes and their lists (#120, #1301): reported at each workflow's assembly. */
export type PiiRuleCode =
  | "pii.not-a-policy"
  | "pii.exclude-not-inherited"
  | "pii.conflicting-rules"
  | "pii.duplicate-target"
  | "pii.missing-refusal"
  | "pii.unused-refusal"
  | "pii.kind-needs-model"
  | "pii.secret-required";
