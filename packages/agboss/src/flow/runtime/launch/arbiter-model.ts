import type { ModelReadingMask } from "../../../pii/model-reading.js";
import type { RouterModel } from "../../../config/types.js";
import type { UsageRecord } from "../../../finops/usage.js";
import {
  ARBITER_ANSWER_DESCRIPTION,
  ARBITER_ANSWER_TOOL,
  ARBITER_QUESTION,
  ARBITER_SYSTEM,
  arbiterAnswerHeading,
} from "../../../prompts/arbiter.js";
import {
  createYesNoDecider,
  type DecisionVoice,
  type LaunchDeciderDeps,
} from "./launch-decider.js";

/**
 * A model arbiter's call (#279): one yes/no decision per arriving answer, on the arbiter's own model
 * — a decision model (`Decision.noul` with the agent's criterion) or a chat model (one answer tool) —
 * under the cost caller `arbiter:<name>`, the arbiter's `prompt` as its instructions. The answer
 * counts when P(yes) > 0.5. A failed call or an unreadable answer is a failure, never a rejection.
 */

/** One answer to judge: the criterion of its agent and the answer as JSON. */
export interface ArbiterQuestion {
  readonly agent: string;
  readonly criterion: string;
  readonly instructions: string;
  readonly answer: unknown;
}

/** What the model said: whether the answer counts, P(yes), what it cost — or why it said nothing. */
export type ArbiterVerdict =
  | {
      readonly kind: "judged";
      readonly passed: boolean;
      readonly probability: number;
      readonly usage: readonly UsageRecord[];
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly cause?: unknown;
      readonly usage: readonly UsageRecord[];
    };

/** A model arbiter on its model. */
export interface ArbiterModel {
  /** `reading`: the answering agent's PII policies (#708) — the model reads the answer masked. */
  readonly judge: (question: ArbiterQuestion, reading?: ModelReadingMask) => Promise<ArbiterVerdict>;
}

/** The cost caller of an arbiter, also its script key in tests. */
export const arbiterCaller = (name: string): string => `arbiter:${name}`;

const voiceOf = (name: string): DecisionVoice => ({
  caller: arbiterCaller(name),
  user: { kind: "arbiter", arbiter: name },
  system: ARBITER_SYSTEM,
  tool: { name: ARBITER_ANSWER_TOOL, description: ARBITER_ANSWER_DESCRIPTION },
});

const inputOf = (question: ArbiterQuestion): string =>
  `${arbiterAnswerHeading(question.agent)}\n${JSON.stringify(question.answer, null, 2)}`;

/** The model arbiter `name` on its model. */
export function createArbiterModel(
  name: string,
  model: RouterModel,
  deps: LaunchDeciderDeps,
): ArbiterModel {
  const decider = createYesNoDecider(voiceOf(name), model, deps);
  return {
    judge: async (question, reading) => {
      const texts = [inputOf(question), question.instructions, question.criterion];
      const read = reading === undefined ? { texts, usage: [] } : await reading(texts);
      const [input = texts[0], instructions = texts[1], criterion = texts[2]] = read.texts;
      const outcome = await decider.decide({
        input: input ?? "",
        instructions: instructions ?? "",
        questions: [{ target: ARBITER_QUESTION, prompt: criterion ?? "" }],
      });
      const usage = [...read.usage, ...(outcome.usage === undefined ? [] : [outcome.usage])];
      if (outcome.kind === "failed") {
        const { reason, cause } = outcome;
        return { kind: "failed", reason, ...(cause === undefined ? {} : { cause }), usage };
      }
      const probability = outcome.probabilities[ARBITER_QUESTION] ?? 0;
      const passed = outcome.launched.includes(ARBITER_QUESTION);
      return { kind: "judged", passed, probability, usage };
    },
  };
}
