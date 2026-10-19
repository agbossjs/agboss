import type { Class } from "../components/injection.js";
import { GuardrailSide, type GuardrailRefusal } from "../components/policy-decorators.js";
import type { RouterModel } from "../config/types.js";
import type { GuardrailOutcome } from "../core/observability.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import type { UsageRecord } from "../finops/usage.js";
import { GuardrailBlockedError } from "../flow/runtime/errors.js";
import {
  createYesNoDecider,
  type DecisionVoice,
  type LaunchDecider,
  type LaunchDeciderDeps,
} from "../flow/runtime/launch/launch-decider.js";
import { reportNodeEvent } from "../flow/observers/execution-event.js";
import { GuardFailedError } from "../graph/errors.js";
import {
  GUARDRAIL_ANSWER_DESCRIPTION,
  GUARDRAIL_ANSWER_TOOL,
  GUARDRAIL_INSTRUCTIONS,
  GUARDRAIL_QUESTION,
  GUARDRAIL_SYSTEM,
  guardrailInputHeading,
  guardrailOutputHeading,
} from "../prompts/guardrail.js";
import type { AssembledGuardrails, LoadedGuardrail } from "./assembly.js";

/**
 * Guardrails at run time (#120): each one a yes / no decision on its own model — a decision model
 * (one `Decision.noul`) or a chat model (one answer tool) — under the cost caller
 * `guardrail:<name>`, its `prompt` the question. Run in list order on the text; the first whose
 * P(yes) reaches its threshold fails the execution with `GuardrailBlockedError`, its refusal (the
 * decorator's text, or the class's `refusal()`) the text to send instead. A model that does not
 * answer fails closed (`GuardFailedError`): nothing passes unchecked.
 */

/** One guardrail ready to check a text: its settings, its model's decision, its refusal. */
export interface RuntimeGuardrail {
  readonly guardrail: LoadedGuardrail;
  readonly decider: LaunchDecider;
  readonly refusal: () => Promise<string>;
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
  readonly modelOf: (model: string) => RouterModel;
  readonly deciderDeps: LaunchDeciderDeps;
}

/** The cost caller of a guardrail, also its script key in tests (`guardrailKeyOf`). */
const guardrailCaller = (name: string): string => `guardrail:${name}`;

const voiceOf = (name: string): DecisionVoice => ({
  caller: guardrailCaller(name),
  user: { kind: "guardrail", guardrail: name },
  system: GUARDRAIL_SYSTEM,
  tool: { name: GUARDRAIL_ANSWER_TOOL, description: GUARDRAIL_ANSWER_DESCRIPTION },
});

const hasRefusal = (value: unknown): value is GuardrailRefusal =>
  typeof value === "object" &&
  value !== null &&
  "refusal" in value &&
  typeof value.refusal === "function";

/** The guardrail's refusal: its text, else its class's `refusal()` (checked at assembly). */
function refusalOf(
  guardrail: LoadedGuardrail,
  resolve: (cls: Class) => unknown,
): () => Promise<string> {
  const { refusal } = guardrail;
  if (refusal !== undefined) return () => Promise.resolve(refusal);
  return async () => {
    const instance = resolve(guardrail.type);
    return hasRefusal(instance) ? await instance.refusal() : "";
  };
}

/** One guardrail on its model. */
export function runtimeGuardrailOf(
  guardrail: LoadedGuardrail,
  parts: GuardrailRuntimeParts,
): RuntimeGuardrail {
  const model = parts.modelOf(guardrail.model);
  const decider = createYesNoDecider(voiceOf(guardrail.name), model, parts.deciderDeps);
  return { guardrail, decider, refusal: refusalOf(guardrail, parts.resolve) };
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

/** What a guardrail checks: the text, whose model it guards, and from which side. */
export interface GuardedText {
  readonly text: string;
  readonly element: string;
  readonly side: GuardrailSide;
}

const headingOf = (checked: GuardedText): string =>
  checked.side === GuardrailSide.Input
    ? guardrailInputHeading(checked.element)
    : guardrailOutputHeading(checked.element);

/** One guardrail's decision, reported to the observers; a failed call fails closed. */
export async function checkGuardrail(
  runtime: RuntimeGuardrail,
  checked: GuardedText,
  spent: UsageRecord[],
  observer: ExecutionObserverManager | undefined,
): Promise<GuardrailOutcome> {
  const { name, prompt, threshold } = runtime.guardrail;
  const input = { side: checked.side, element: checked.element, text: checked.text };
  await reportNodeEvent((base) => observer?.onGuardrailStart({ ...base, name, input }));
  const outcome = await runtime.decider.decide({
    input: `${headingOf(checked)}\n${checked.text}`,
    instructions: GUARDRAIL_INSTRUCTIONS,
    questions: [{ target: GUARDRAIL_QUESTION, prompt }],
  });
  if (outcome.usage !== undefined) spent.push(outcome.usage);
  if (outcome.kind === "failed") throw new GuardFailedError(name, [...spent], outcome.reason);
  const probability = outcome.probabilities[GUARDRAIL_QUESTION] ?? 0;
  const update: GuardrailOutcome = { isBlocked: probability >= threshold, probability };
  await reportNodeEvent((base) => observer?.onGuardrailEnd({ ...base, name, update }));
  return update;
}

/**
 * The guardrails on one text, in order: their spend when every one passes; the first that blocks
 * fails the execution with `GuardrailBlockedError` (its refusal, its spend so far).
 */
export async function runGuardrails(
  guardrails: readonly RuntimeGuardrail[],
  checked: GuardedText,
  observer?: ExecutionObserverManager,
): Promise<readonly UsageRecord[]> {
  const spent: UsageRecord[] = [];
  for (const runtime of guardrails) {
    const outcome = await checkGuardrail(runtime, checked, spent, observer);
    if (!outcome.isBlocked) continue;
    const { name, threshold } = runtime.guardrail;
    const refusal = await runtime.refusal();
    throw new GuardrailBlockedError(name, refusal, spent, {
      probability: outcome.probability,
      threshold,
    });
  }
  return spent;
}
