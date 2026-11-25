import type { UncompactedTurns } from "../memory/memory.decorator.js";
import { formatHistory, formatSummaries } from "../flow/runtime/history.js";
import { answerToolDescription } from "../flow/runtime/answer-tools.js";
import { ONE_ANSWER_MESSAGE } from "../graph/agent-loop/answer-node.js";
import { formatDecisionsForAgent } from "../graph/agent-loop/input-node.js";
import { retryPrompt } from "../graph/agent-loop/judge-retry-prompt.js";
import { answerWithToolMessage } from "../graph/agent-loop/reply-node.js";
import type { AnyPiiAction } from "../pii/actions.js";
import type { AssembledPii } from "../pii/assembly.js";
import { isCustomPolicy, type PiiPolicyMeta } from "../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import type { PiiRuntime } from "../pii/runtime.js";
import { agentLoopPromptTexts } from "../prompts/agents.js";
import type { AgentExecutionDeps } from "./types.js";

/**
 * What an agent's or a model router's model reads that its own decorator does not say (#120 PR 4),
 * as a sub-tree of the workflow's fingerprint (`configHash`): the PII policies in effect at its
 * model (application + workflow + own − excluded), how much of the thread it sees in full and the
 * compaction that summarises the rest, and the judges of its answer. Plus the framework's own texts
 * an agent's model reads (the answer instructions, the history and the decisions framing, a judge's
 * retry). Quality metrics stay out (#123).
 */

/** One PII rule as fingerprinted: its kind or group and its action, a pattern as its text. */
export interface PiiRuleFingerprint {
  readonly target: string;
  readonly action: Readonly<Record<string, unknown>>;
}

/** One PII policy as fingerprinted: its rules (and model) or a project detector's action. */
export interface PiiPolicyFingerprint {
  readonly name: string;
  readonly rules?: readonly PiiRuleFingerprint[];
  readonly model?: string;
  /** What it lets happen to files (#899): only a policy that says. */
  readonly files?: string;
  readonly action?: Readonly<Record<string, unknown>>;
}

/** One judge of an agent's answer as fingerprinted: its name and its model. */
export interface JudgeFingerprint {
  readonly name: string;
  readonly model: string | null;
}

/** What one agent or model router reads besides its decorator. */
export interface ElementFingerprint {
  readonly uncompactedTurns: UncompactedTurns;
  /** The memory of the reader; absent = none. */
  readonly memory?: string;
  /** Absent = none. */
  readonly piiPolicies?: readonly PiiPolicyFingerprint[];
  /** Absent = none. */
  readonly judges?: readonly JudgeFingerprint[];
}

/**
 * What the fingerprints are made from: an assembled workflow (`agboss describe`) or its run
 * dependencies — the same fingerprint from both (its PII policies assembled, or at run time).
 */
export interface FingerprintDeps {
  readonly config: AgentExecutionDeps<string>["config"];
  readonly routers: AgentExecutionDeps<string>["routers"];
  readonly memories?: AgentExecutionDeps<string>["memories"];
  readonly pii?: PiiRuntime | AssembledPii | undefined;
}

/** The PII policies at one element's model, as declared. */
function piiMetasOf(pii: FingerprintDeps["pii"], element: string): readonly PiiPolicyMeta[] {
  if (pii === undefined) return [];
  // as declared (#1150): a child's inherited policies never change its configHash
  if ("policiesOf" in pii)
    return pii.declared.policiesOf(element).policies.map((policy) => policy.meta);
  // as `policiesOf` reads it (#708): a copy's node, else the workflow's policies — never none
  const classes =
    pii.byElement.get(element) ??
    pii.byElement.get(element.split("#")[0] ?? element) ??
    pii.observability;
  return classes.flatMap((cls) => piiPolicyMetaOf(cls) ?? []);
}

/**
 * What a workflow hands down to the children it launches (#1150): the application's and its own
 * `@Workflow` lists as declared (its observability set, none inherited — an ancestor's are in the
 * ancestor's hash), each once by name in order. A child's models read them, but the child's own
 * hash covers only what it declares, so the launching workflow's hash must cover them — also when
 * it has no agent or router whose fingerprint would.
 */
export function handedDownPiiOf(pii: FingerprintDeps["pii"]): readonly PiiPolicyFingerprint[] {
  if (pii === undefined) return [];
  const metas =
    "policiesOf" in pii
      ? pii.declared.observed.policies.map((policy) => policy.meta)
      : pii.observability.flatMap((cls) => piiPolicyMetaOf(cls) ?? []);
  return metas.map(piiPolicyFingerprint);
}

/** An action as plain data: a `mask({ pattern })` regular expression as its text. */
const actionFingerprint = (action: AnyPiiAction): Readonly<Record<string, unknown>> =>
  "part" in action && action.part.pattern !== undefined
    ? { ...action, part: { ...action.part, pattern: String(action.part.pattern) } }
    : { ...action };

function piiPolicyFingerprint(meta: PiiPolicyMeta): PiiPolicyFingerprint {
  if (isCustomPolicy(meta))
    return {
      name: meta.name,
      action: actionFingerprint(meta.action),
      ...(meta.files === undefined ? {} : { files: meta.files }),
    };
  return {
    name: meta.name,
    ...(meta.files === undefined ? {} : { files: meta.files }),
    rules: meta.rules.map((rule) => ({
      target: rule.target.id,
      action: actionFingerprint(rule.action),
    })),
    ...(meta.model === undefined ? {} : { model: meta.model }),
  };
}

function judgesOf(deps: FingerprintDeps, agent: string): readonly JudgeFingerprint[] {
  const names = deps.config.agents[agent]?.judges ?? [];
  return names.map((name) => ({ name, model: deps.config.judges?.[name]?.model ?? null }));
}

function elementFingerprint(deps: FingerprintDeps, name: string): ElementFingerprint {
  const reader = deps.memories?.readers.get(name);
  const policies = piiMetasOf(deps.pii, name);
  const judges = judgesOf(deps, name);
  return {
    uncompactedTurns:
      reader?.uncompactedTurns ??
      deps.config.agents[name]?.uncompactedTurns ??
      deps.config.defaults.uncompactedTurns,
    ...(reader?.memory === undefined ? {} : { memory: reader.memory }),
    ...(policies.length === 0 ? {} : { piiPolicies: policies.map(piiPolicyFingerprint) }),
    ...(judges.length === 0 ? {} : { judges }),
  };
}

/** Every agent's and model router's fingerprint, by name. */
export const elementFingerprintsOf = (
  deps: FingerprintDeps,
): Readonly<Record<string, ElementFingerprint>> =>
  Object.fromEntries(
    [...Object.keys(deps.config.agents), ...deps.routers.map((router) => router.name)].map(
      (name) => [name, elementFingerprint(deps, name)],
    ),
  );

/** The texts the framework adds to what an agent's model reads (the prompt and config versions). */
export const agentFramePromptTexts: readonly string[] = [
  ...agentLoopPromptTexts,
  ONE_ANSWER_MESSAGE,
  answerWithToolMessage([]),
  answerToolDescription("", false),
  answerToolDescription("", true),
  formatHistory([{ start: "", finish: "" }], 1),
  formatSummaries([""], 1),
  formatDecisionsForAgent([{ agent: "", tool: "", args: {}, approved: true, by: "" }], ""),
  retryPrompt([{ judge: "", reason: "" }]),
];
