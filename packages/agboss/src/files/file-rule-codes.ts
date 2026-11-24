/** The rule codes of an agent's files (#899, and its PII file rules): reported with every other assembly rule. */
export type FileRuleCode =
  | "files.invalid-setting"
  | "files.no-redactor"
  | "files.redacted-needs-store"
  | "files.history-needs-store"
  | "files.redactor-values-withheld"
  | "files.answer-file-unseen"
  | "pii.original-file"
  | "pii.redacted-needs-kinds"
  | "file-policy.invalid"
  | "file-policy.not-a-file-policy"
  | "workflow.file-policy-required"
  | "a2a.skill-file-policy-exceeds-workflow";
