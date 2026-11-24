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

/** The rule codes that live beside their feature, not in the one list. */
export type ExtraRuleCode = FileRuleCode | PiiRuleCode | StorageRuleCode;
