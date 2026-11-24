import type { Class } from "../components/injection.js";
import { bytes } from "../units/index.js";
import type { GuardrailRefusal } from "../components/policy-decorators.js";
import type { RouterModel } from "../config/types.js";
import type { GuardrailOutcome } from "../core/observability.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import type { UsageRecord } from "../finops/usage.js";
import { GuardrailBlockedError } from "../flow/runtime/errors.js";
import type { LaunchDeciderDeps } from "../flow/runtime/launch/launch-decider.js";
import { reportNodeEvent } from "../flow/observers/execution-event.js";
import { GuardFailedError } from "../graph/errors.js";
import { isModelGuardrail, type AssembledGuardrails, type LoadedGuardrail } from "./assembly.js";
import type { GuardedText } from "./guarded-text.js";
import { CODE_GUARDRAIL_THRESHOLD, codeGuardrailDecision, contentOf } from "./code-guardrail.js";
import type { GuardrailContent } from "../components/guardrail-handler.js";
import { guardrailDecisionOf, type GuardrailDecisionRecord } from "../flow/runtime/step-records.js";
import { carryRecords } from "../flow/runtime/carried-records.js";
import { modelDecisionOf } from "./model-decision.js";

/**
 * Guardrails at run time (#120): each one a yes / no decision on its own model — a decision model
 * (one `Decision.boolean`) or a chat model (one answer tool) — under the cost caller
 * `guardrail:<name>`, its `prompt` the question. Run in list order on the text; the first whose
 * P(yes) reaches its threshold fails the execution with `GuardrailBlockedError`, its refusal (the
 * verdict's text, the decorator's text, or the class's `refusal(content)`) the text to send instead. A model that does not
 * answer fails closed (`GuardFailedError`): nothing passes unchecked. A code guardrail (#383)
 * decides by its class's `check(content)` instead — no model call, no spend (`code-guardrail.ts`).
 */

/**
 * What a guardrail decided on one text: its outcome, and — a code guardrail's `blocked(refusal)` —
 * the refusal of this call. The refusal is the call's own, never read from the shared instance.
 */
export type GuardrailDecided = GuardrailOutcome & { readonly refusal?: string };

/** How one guardrail decides on a text: its outcome; a model's spend goes into `spent`. */
export type GuardrailDecision = (
  checked: GuardedText,
  spent: UsageRecord[],
) => Promise<GuardrailDecided>;

/** One guardrail ready to check a text: its settings, its decision (model or code), its refusal. */
export interface RuntimeGuardrail {
  readonly guardrail: LoadedGuardrail;
  readonly decide: GuardrailDecision;
  /** The text sent when it blocks without its own: the decorator's, else the class's `refusal(content)`; none = fails closed. */
  readonly refusal: (content: GuardrailContent) => Promise<string | undefined>;
}

/** The guardrails of each agent and model router, by side. */
export interface GuardrailRuntime {
  /** Every guardrail of the workflow (its prompt and model versions). */
  readonly guardrails: readonly LoadedGuardrail[];
  readonly inputOf: (element: string) => readonly RuntimeGuardrail[];
  readonly outputOf: (element: string) => readonly RuntimeGuardrail[];
}

/** What the runtime is built from: the container's instances and the models. */
export interface GuardrailRuntimeParts {
  readonly resolve: (cls: Class) => unknown;
  readonly modelOf: (model: string, modelProvider?: string, unpriced?: true) => RouterModel;
  readonly deciderDeps: LaunchDeciderDeps;
}

const hasRefusal = (value: unknown): value is GuardrailRefusal =>
  typeof value === "object" &&
  value !== null &&
  "refusal" in value &&
  typeof value.refusal === "function";

/** The guardrail's refusal: its text, else its class's `refusal(content)`; none when it has neither. */
function refusalOf(
  guardrail: LoadedGuardrail,
  resolve: (cls: Class) => unknown,
): RuntimeGuardrail["refusal"] {
  const { refusal } = guardrail;
  if (refusal !== undefined) return () => Promise.resolve(refusal);
  return async (content) => {
    const instance = resolve(guardrail.type);
    return hasRefusal(instance) ? await instance.refusal(content) : undefined;
  };
}

/** One guardrail on its model, or on its class's `check(content)` (#383). */
export function runtimeGuardrailOf(
  guardrail: LoadedGuardrail,
  parts: GuardrailRuntimeParts,
): RuntimeGuardrail {
  const decide: GuardrailDecision = isModelGuardrail(guardrail)
    ? modelDecisionOf(guardrail, parts)
    : codeGuardrailDecision(guardrail, parts.resolve);
  return { guardrail, decide, refusal: refusalOf(guardrail, parts.resolve) };
}

/** The runtime of a workflow's guardrails; none assembled → none anywhere. */
export function guardrailRuntimeOf(
  assembled: AssembledGuardrails | undefined,
  parts: GuardrailRuntimeParts,
): GuardrailRuntime {
  const made = new Map(
    (assembled?.guardrails ?? []).map((guardrail) => [
      guardrail.type,
      runtimeGuardrailOf(guardrail, parts),
    ]),
  );
  const of = (list: readonly LoadedGuardrail[] | undefined): readonly RuntimeGuardrail[] =>
    (list ?? []).flatMap((guardrail) => made.get(guardrail.type) ?? []);
  return {
    guardrails: assembled?.guardrails ?? [],
    inputOf: (element) => of(assembled?.byElement.get(element)?.input),
    outputOf: (element) => of(assembled?.byElement.get(element)?.output),
  };
}

/** One guardrail's decision, reported to the observers; a failed call fails closed. */
export async function checkGuardrail(
  runtime: RuntimeGuardrail,
  checked: GuardedText,
  spent: UsageRecord[],
  observer: ExecutionObserverManager | undefined,
): Promise<GuardrailDecided> {
  const { name } = runtime.guardrail;
  const files = (checked.files ?? []).map(({ content }) => ({
    mediaType: content.mediaType,
    ...(content.filename === undefined ? {} : { filename: content.filename }),
    sizeBytes: bytes(content.bytes.byteLength),
    sha256: content.sha256,
  }));
  const input = {
    side: checked.side,
    element: checked.element,
    text: checked.text,
    ...(files.length === 0 ? {} : { files }),
  };
  await reportNodeEvent((base) => observer?.onGuardrailStart({ ...base, name, input }));
  const decided = await runtime.decide(checked, spent);
  // observers see the outcome, never the refusal text
  const update: GuardrailOutcome = {
    isBlocked: decided.isBlocked,
    probability: decided.probability,
  };
  await reportNodeEvent((base) => observer?.onGuardrailEnd({ ...base, name, output: update }));
  return decided;
}

/** Guardrails that all passed: their spend and decisions (#395 C3). */
export interface GuardrailsPassed {
  readonly usage: readonly UsageRecord[];
  readonly decisions: readonly GuardrailDecisionRecord[];
}

/** What the guardrails on one text decided: all passed, or the first that blocked (and what it, and those before it, cost). */
export type GuardrailsChecked =
  | ({ readonly kind: "passed" } & GuardrailsPassed)
  | {
      readonly kind: "blocked";
      readonly error: GuardrailBlockedError;
      readonly usage: readonly UsageRecord[];
      readonly decisions: readonly GuardrailDecisionRecord[];
    };

/**
 * The guardrails on one text, in order: all passed, or the first that blocks — as a value, so a caller
 * that can survive a block (a tool call whose result files were blocked, #899 §8) does. A guardrail
 * that cannot decide still throws `GuardFailedError`: nothing passes unchecked.
 */
export async function checkGuardrails(
  guardrails: readonly RuntimeGuardrail[],
  checked: GuardedText,
  observer?: ExecutionObserverManager,
): Promise<GuardrailsChecked> {
  const spent: UsageRecord[] = [];
  const decisions: GuardrailDecisionRecord[] = [];
  for (const runtime of guardrails) {
    const outcome = await checkGuardrail(runtime, checked, spent, observer);
    decisions.push(guardrailDecisionOf(runtime.guardrail.name, checked.side, outcome));
    if (!outcome.isBlocked) continue;
    const { guardrail } = runtime;
    const { name } = guardrail;
    const threshold = isModelGuardrail(guardrail) ? guardrail.threshold : CODE_GUARDRAIL_THRESHOLD;
    const refusal = outcome.refusal ?? (await runtime.refusal(contentOf(checked)));
    if (refusal === undefined)
      throw new GuardFailedError({
        guard: name,
        usage: [...spent],
        reason:
          "blocked with no refusal — give blocked(refusal), the decorator { refusal } or the class a refusal(content) method",
      });
    const blocked = { probability: outcome.probability, threshold };
    const error = new GuardrailBlockedError({ guard: name, refusal, usage: spent, ...blocked });
    carryRecords(error, { guardrailDecisions: decisions }); // the blocking one last (#395 S6)
    return { kind: "blocked", error, usage: spent, decisions };
  }
  return { kind: "passed", usage: spent, decisions };
}

/**
 * The guardrails on one text, in order: their spend and decisions when every one passes; the first that blocks
 * fails the execution with `GuardrailBlockedError` (its refusal, its spend so far).
 */
export async function runGuardrails(
  guardrails: readonly RuntimeGuardrail[],
  checked: GuardedText,
  observer?: ExecutionObserverManager,
): Promise<GuardrailsPassed> {
  const result = await checkGuardrails(guardrails, checked, observer);
  if (result.kind === "blocked") throw result.error;
  return result;
}
