import { GuardrailSide } from "../components/policy-decorators.js";
import {
  createYesNoDecider,
  type DecisionVoice,
  type LaunchDecider,
} from "../flow/runtime/launch/launch-decider.js";
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
import type { LoadedModelGuardrail } from "./assembly.js";
import { piecesOfGuarded, type GuardedText } from "./guarded-text.js";
import type { GuardrailDecision, GuardrailRuntimeParts } from "./runtime.js";

/** A model guardrail at run time (#120): one yes / no decision on its model. */

const headingOf = (checked: GuardedText): string =>
  checked.side === GuardrailSide.Input
    ? guardrailInputHeading(checked.element)
    : guardrailOutputHeading(checked.element);

/** The cost caller of a guardrail, also its script key in tests (`guardrailKeyOf`). */
const guardrailCaller = (name: string): string => `guardrail:${name}`;

const voiceOf = (name: string): DecisionVoice => ({
  caller: guardrailCaller(name),
  user: { kind: "guardrail", guardrail: name },
  system: GUARDRAIL_SYSTEM,
  tool: { name: GUARDRAIL_ANSWER_TOOL, description: GUARDRAIL_ANSWER_DESCRIPTION },
});

/** A model guardrail's decision: one yes / no on its model; a failed call fails closed. */
export function modelDecisionOf(
  guardrail: LoadedModelGuardrail,
  parts: GuardrailRuntimeParts,
): GuardrailDecision {
  const { name, prompt, threshold } = guardrail;
  const model = parts.modelOf(guardrail.model);
  const decider: LaunchDecider = createYesNoDecider(voiceOf(name), model, parts.deciderDeps);
  return async (checked, spent) => {
    const outcome = await decider.decide({
      input: `${headingOf(checked)}\n${checked.text}`,
      pieces: piecesOfGuarded(checked),
      instructions: GUARDRAIL_INSTRUCTIONS,
      questions: [{ target: GUARDRAIL_QUESTION, prompt }],
    });
    if (outcome.usage !== undefined) spent.push(outcome.usage);
    if (outcome.kind === "failed")
      throw new GuardFailedError({
        guard: name,
        usage: [...spent],
        reason: outcome.reason,
        // the call's own error: `.onError(ModelCallError, …)` finds it through the cause chain
        ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
      });
    const probability = outcome.probabilities[GUARDRAIL_QUESTION] ?? 0;
    return { isBlocked: probability >= threshold, probability };
  };
}
