import type { EvalRuleCode } from "../eval/suite/eval-rule-codes.js";
import type { FileRuleCode } from "../files/file-rule-codes.js";
import type { ModelProviderRuleCode } from "../models/model-rule-codes.js";
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

/** Codes of an `@A2AEndpoint`: its ttl, and a start listed twice (#1320). */
export type A2AEndpointRuleCode = "a2a.ttl-invalid" | "a2a.duplicate-skill";

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
  | "pause.setting-not-enforced"
  | "channel-listener.missing-handler"
  | "channel-listener.unknown-hook"
  | "channel-interpreter.not-an-interpreter"
  | "channel-interpreter.no-interpret-method";

/**
 * Codes of the parallel launches `.inParallel([…])` and `.forEachItem(…)` (#1279, #1280), and of a
 * quorum join's working-time `deadline` (#1306).
 */
export type ParallelLaunchRuleCode =
  | "launch.skip-differs"
  | "launch.for-each-item-no-list"
  | "launch.max-items-handler-required"
  | "calendar.required-for-working-duration";

/** A field of a context subclass that shadows one the framework sets (#1316f). */
export type ContextRuleCode = "context.reserved-field";

/** A decorator was given an option it does not take (#1313, #1318, #1324). */
export type DecoratorRuleCode = "decorator.unknown-option";

/** The rule codes that live beside their feature, not in the one list. */
export type ExtraRuleCode =
  | A2AEndpointRuleCode
  | ContextRuleCode
  | DecoratorRuleCode
  | EvalRuleCode
  | FileRuleCode
  | ModelProviderRuleCode
  | ParallelLaunchRuleCode
  | PauseTargetRuleCode
  | PiiRuleCode
  | StorageRuleCode;
