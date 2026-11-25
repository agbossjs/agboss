import { KEY_TEXT_RULE_TEXT, type KeyTextRule } from "../key-text-rule.js";
import type { CompensationRecord } from "../../flow/compensation.js";
import type { ResumeVersions } from "../../run/resume-guard.js";

/** The sentences of the `ExecutionError` variants that are made of their facts: never of a stored or model text. */

/** What `ExecutionError.InvalidThreadId` says: the rule it breaks — never the id. */
export const invalidThreadIdMessageOf = (facts: Partial<{ readonly rule: KeyTextRule }>): string =>
  facts.rule === undefined
    ? "the thread id is not a key"
    : `Not a thread id (${facts.rule}): ${KEY_TEXT_RULE_TEXT[facts.rule]}`;

/** What `ExecutionError.ThreadIdsExhausted` says: the generator and the tries, never an id. */
export const threadIdsExhaustedMessageOf = (
  facts: Partial<{ readonly generator: string; readonly tries: number }>,
): string =>
  `${facts.generator ?? "the IdGenerator"}.newThreadId() minted ${String(facts.tries ?? 0)} ids in a row that are threads the tenant has — an IdGenerator never repeats an id over the life of the application's stores`;

/** What `ExecutionError.DuplicateExecutionId` says: the generator, never the id. */
export const duplicateExecutionIdMessageOf = (
  facts: Partial<{ readonly generator: string }>,
): string =>
  `${facts.generator ?? "the IdGenerator"}.newExecutionId() minted an execution id another execution already has — an IdGenerator never repeats an id over the life of the application's stores`;

const shortHash = (hash: string): string => hash.slice(0, 12);

const versionsLabel = ({ workflowVersion, configHash }: ResumeVersions): string =>
  `${workflowVersion} (config ${shortHash(configHash)})`;

/** What `ExecutionError.IncompatibleResume` says: the two versions, and the way out. */
export const incompatibleResumeMessageOf = (
  facts: Partial<{
    readonly threadId: string;
    readonly paused: ResumeVersions;
    readonly current: ResumeVersions;
  }>,
): string =>
  facts.paused === undefined || facts.current === undefined
    ? "the execution cannot be resumed by this version"
    : `[resume.incompatible] thread "${facts.threadId ?? ""}" paused under ${versionsLabel(facts.paused)}, ` +
      `this app runs ${versionsLabel(facts.current)} — register ` +
      `WorkflowSettings.builder().onIncompatibleResume(…) to resume it anyway ` +
      `(limits, ttl and provider fallback settings are not part of the config, so a profile that only tunes them never causes this)`;

/** What `ExecutionError.InvalidMintedId` says: the generator, the method and the rule, never the id. */
export const invalidMintedIdMessageOf = (
  facts: Partial<{
    readonly generator: string;
    readonly method: "newThreadId" | "newExecutionId";
    readonly rule: KeyTextRule;
  }>,
): string =>
  facts.rule === undefined
    ? "an id the IdGenerator minted is not a key"
    : `${facts.generator ?? "the IdGenerator"}.${facts.method ?? "newExecutionId"}() minted an id that is no key (${facts.rule}): ${KEY_TEXT_RULE_TEXT[facts.rule]} — fix the IdGenerator`;

/** What `ExecutionError.CompensationFailed` says: each undo that threw, and that the others ran. */
export const compensationFailedMessageOf = (
  facts: Partial<{ readonly failures: readonly CompensationRecord[] }>,
): string => {
  const undone = (facts.failures ?? []).map(
    (f) =>
      `${f.compensator.name} (compensates ${f.compensated.component.name}): ${f.error?.message ?? "failed"}`,
  );
  return undone.length === 0
    ? "an automatic undo failed"
    : `An automatic undo failed — ${undone.join("; ")}; the others ran`;
};

/** What `ExecutionError.CancelFenced` says: the write refused after its tree's cancel — nothing written or sent. */
export const cancelFencedMessageOf = (
  facts: Partial<{ readonly effect: string; readonly rootExecutionId: string }>,
): string =>
  facts.effect === undefined || facts.rootExecutionId === undefined
    ? "the execution was cancelled and its writes are fenced"
    : `"${facts.effect}" of execution ${facts.rootExecutionId} was refused: its tree's cancel was requested — nothing was written or sent`;
