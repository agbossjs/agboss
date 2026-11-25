import {
  A2AContractRule,
  type A2AClientOperation,
  type A2ARemoteCallReason,
} from "./a2a-client-errors.js";
import type { A2AOriginSite } from "./a2a-guard-errors.js";
import type { A2ACancelOutcome, A2ATaskEnd, A2ATaskInterruption } from "./a2a-task-errors.js";

/**
 * The sentences of the `A2AError` variants a client call fails with (#809, design §4.2): each is made
 * of the stable facts only — the agent, the operation, the JSON-RPC or HTTP code, the task's ids and
 * state — never of a remote text, which may carry its internals or unmasked personal data. A variant
 * made with no fact (`explain` does) still has a sentence.
 */

/** At most this many versions of a card are named. */
const MAX_VERSIONS = 5;

/** The versions a card declares that read as versions (`0.3`, `0.3.0`): never a free text. */
export const versionsShownOf = (versions: readonly string[]): readonly string[] =>
  versions.filter((version) => /^\d{1,3}(\.\d{1,3}){0,2}$/u.test(version)).slice(0, MAX_VERSIONS);

const agentOf = (facts: { readonly agent?: string | undefined }): string => facts.agent ?? "(any)";

/** What `A2AError.Remote` says. */
export const remoteCallMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly reason: A2ARemoteCallReason;
    readonly taskId: string | undefined;
  }>,
): string => {
  const task = facts.taskId === undefined ? "" : ` (task ${facts.taskId})`;
  return `A2A agent ${agentOf(facts)} gave no usable answer${task}: ${facts.reason ?? "no reason"}`;
};

const protocolAnswerOf = (
  facts: Partial<{
    readonly rpcCode: number | undefined;
    readonly httpStatus: number | undefined;
    readonly protocolVersions: readonly string[] | undefined;
  }>,
): string => {
  if (facts.protocolVersions !== undefined) {
    const shown = versionsShownOf(facts.protocolVersions);
    const versions = shown.length === 0 ? "none" : shown.join(", ");
    return `its Agent Card declares A2A ${versions} — this client speaks A2A 1.0 only (a v0.3 agent is not supported in 0.1.1)`;
  }
  if (facts.rpcCode !== undefined) return `JSON-RPC error ${String(facts.rpcCode)}`;
  if (facts.httpStatus !== undefined) return `HTTP ${String(facts.httpStatus)}`;
  return "an answer that is no A2A response";
};

/** What `A2AError.Protocol` says. */
export const protocolMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly operation: A2AClientOperation;
    readonly rpcCode: number | undefined;
    readonly httpStatus: number | undefined;
    readonly protocolVersions: readonly string[] | undefined;
  }>,
): string =>
  `A2A agent ${agentOf(facts)} answered ${facts.operation ?? "a request"} with ${protocolAnswerOf(facts)}`;

/** What `A2AError.Contract` says. */
export const contractMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly rule: A2AContractRule;
    readonly skill: string | undefined;
    readonly differences: readonly string[] | undefined;
  }>,
): string => {
  const skill = facts.skill ?? "";
  const differences = facts.differences ?? [];
  const listed = differences.length === 0 ? "" : `: ${differences.join("; ")}`;
  const rule = facts.rule ?? A2AContractRule.SchemaMismatch;
  const what = {
    [A2AContractRule.UnknownSkill]: `its Agent Card has no skill "${skill}"`,
    [A2AContractRule.SchemaMismatch]: `the schemas of its skill "${skill}" do not match the client's DTOs`,
    [A2AContractRule.UnknownFinish]: `its skill "${skill}" has no finish the client names`,
    [A2AContractRule.RepeatedCall]:
      "this step already called it with another message — give each call of one step its own key ({ key })",
  }[rule];
  return `[${rule}] A2A agent ${agentOf(facts)}: ${what}${listed} — nothing was sent`;
};

/** What `A2AError.TaskFailed` says. */
export const taskFailedMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly taskId: string;
    readonly end: A2ATaskEnd;
    readonly remoteCode: string | undefined;
  }>,
): string => {
  const code = facts.remoteCode === undefined ? "" : ` (${facts.remoteCode})`;
  return `the task ${facts.taskId ?? "(none)"} of A2A agent ${agentOf(facts)} ended ${facts.end ?? "without an output"}${code}`;
};

/** What `A2AError.TaskCancelled` says. */
export const taskCancelledMessageOf = (
  facts: Partial<{ readonly agent: string; readonly taskId: string }>,
): string => `the task ${facts.taskId ?? "(none)"} of A2A agent ${agentOf(facts)} was canceled`;

/** What `A2AError.TaskInterrupted` says. */
export const taskInterruptedMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly taskId: string;
    readonly interruption: A2ATaskInterruption;
  }>,
): string =>
  `the task ${facts.taskId ?? "(none)"} of A2A agent ${agentOf(facts)} waits for its caller (${facts.interruption ?? "input-required"}): reply(taskId, …) continues it`;

/** What `A2AError.Deadline` says. */
export const deadlineMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly taskId: string;
    readonly deadlineAt: Date;
    readonly cancel: A2ACancelOutcome;
  }>,
): string => {
  const by = facts.deadlineAt === undefined ? "its deadline" : facts.deadlineAt.toISOString();
  return `the task ${facts.taskId ?? "(none)"} of A2A agent ${agentOf(facts)} did not end by ${by}: the cancel asked: ${facts.cancel ?? "none"}`;
};

/** What `A2AError.OriginRefused` says. */
export const originMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly origin: string;
    readonly site: A2AOriginSite;
    readonly allowedOrigins: readonly string[];
  }>,
): string =>
  `[a2a.origin-refused] A2A agent ${agentOf(facts)}: ${facts.site ?? "a request"} at ${facts.origin ?? "(no origin)"}, outside its origins (${(facts.allowedOrigins ?? []).join(", ")}) — nothing was sent there; list it in allowedOrigins if it is the agent's`;

/** What `A2AError.MeshUnsupported` says. */
export const meshUnsupportedMessageOf = (
  facts: Partial<{ readonly agent: string; readonly application: string | undefined }>,
): string => {
  const target = facts.application === undefined ? "" : ` (${facts.application})`;
  return `A2A agent ${agentOf(facts)}${target} does not declare the AGBoss mesh extension, which the call requires — nothing was sent; mesh: A2AMesh.IfSupported calls it without the mesh`;
};

/** What `A2AError.UnexpectedFinish` says. */
export const unexpectedFinishMessageOf = (
  facts: Partial<{
    readonly agent: string;
    readonly finish: string | undefined;
    readonly finishes: readonly string[];
  }>,
): string => {
  const ended = facts.finish ?? "a finish of no valid name";
  return `A2A agent ${agentOf(facts)} ended at ${ended}, not one of the finishes the client takes (${(facts.finishes ?? []).join(", ")})`;
};
