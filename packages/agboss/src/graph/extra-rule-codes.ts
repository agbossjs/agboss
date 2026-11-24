import type { FileRuleCode } from "../files/file-rule-codes.js";
import type { PiiRuleCode } from "../pii/pii-rule-codes.js";

/** Codes of `@Application({ storage })` and its three storage components (#1321). */
export type StorageRuleCode =
  | "storage.not-a-storage"
  | "storage.driver-invalid"
  | "storage.database-required"
  | "storage.cluster-needs-durable-lease-store"
  | "storage.providers-conflict"
  | "storage.retention-conflict"
  | "storage.key-conflict"
  | "storage.secret-shared"
  | "storage.ttl-invalid";

/** Codes of the pause targets, their channels, selectors, interpreters and listeners (#1307, #1310). */
export type PauseTargetRuleCode =
  | "channel.missing-for-target"
  | "channel.ambiguous-for-target"
  | "channel.target-invalid"
  | "channel.ttl-invalid"
  | "channel-selector.no-select-method"
  | "channel-selector.target-invalid"
  | "pause.incompatible-escalation-target"
  | "pause.permit-hook-not-enforced"
  | "channel-listener.missing-handler"
  | "channel-listener.unknown-hook"
  | "channel-interpreter.not-an-interpreter"
  | "channel-interpreter.no-interpret-method";

/** The rule codes that live beside their feature, not in the one list. */
export type ExtraRuleCode = FileRuleCode | PauseTargetRuleCode | PiiRuleCode | StorageRuleCode;
