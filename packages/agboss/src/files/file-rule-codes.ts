/** The rule codes of an agent's files (#899): reported with every other assembly rule. */
export type FileRuleCode =
  | "files.invalid-setting"
  | "files.no-redactor"
  | "files.redacted-needs-store"
  | "files.history-needs-store"
  | "files.redactor-values-withheld"
  | "files.answer-file-unseen";
