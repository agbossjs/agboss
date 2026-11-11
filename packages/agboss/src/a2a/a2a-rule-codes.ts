/** Codes of the assembly rules of an application serving A2A — part of `RuleCode`. */
export type A2ARuleCode =
  // an application serving A2A keeps its tasks where its instances share them (#824)
  | "a2a.task-store-not-shared"
  | "a2a.message-store-not-shared"
  // a direct-reply skill (#860) is stateless
  | "a2a.message-skill-pause"
  | "a2a.message-skill-effect"
  | "a2a.message-skill-tool"
  | "a2a.message-skill-compensation"
  | "a2a.message-skill-child"
  | "a2a.unknown-skill-option"
  // how the card describes file fields (#904)
  | "a2a.card-file-fields-invalid"
  // the files of a skill (#859)
  | "a2a.file-options-invalid"
  | "a2a.file-store-required"
  | "a2a.file-store-not-shared"
  | "a2a.nested-file-field";
