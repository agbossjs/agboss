import { z } from "zod";
import { CostSource, type UsageRecord } from "../finops/usage.js";
import { DecisionResponseError } from "./decision-errors.js";
import type { DecisionAnswer, DecisionQuestion, DecisionQuestions } from "./decisions.js";

const Probabilities = z.record(z.string(), z.number().min(0).max(1));

const AnswerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: Probabilities,
    confidence: z.number(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("score"),
    score: z.number().int().nonnegative(),
    probabilities: Probabilities,
    legend: z.record(z.string(), z.string()),
    confidence: z.number(),
  }),
]);

const ResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      // a cost below zero would take spend off the budgets' counters: an invalid answer (#817)
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

/** A decision's answers by question id, and what the call cost (under its caller). */
export interface DecisionOutcome {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly usage: UsageRecord;
}

/** Who asked, on which model, which questions. */
export interface DecisionAsked {
  readonly caller: string;
  readonly model: string;
  readonly questions: DecisionQuestions;
}

/** Why an answer does not fit its question, or undefined when it does. */
function misfit(question: DecisionQuestion, answer: DecisionAnswer): string | undefined {
  if (answer.type !== question.type)
    return `a ${answer.type} answer to a ${question.type} question`;
  if (
    answer.type === "choice" &&
    question.type === "choice" &&
    !Object.hasOwn(question.criteria, answer.choice)
  ) {
    return `choice "${answer.choice}" is not one of its options`;
  }
  if (
    answer.type === "score" &&
    question.type === "score" &&
    answer.score >= question.criteria.length
  ) {
    return `score ${String(answer.score)} is past its ${String(question.criteria.length)} levels`;
  }
  return undefined;
}

function answerOf(
  id: string,
  question: DecisionQuestion,
  raw: unknown,
  model: string,
): DecisionAnswer {
  const fail = (why: string): DecisionResponseError =>
    new DecisionResponseError({
      message: `Decisions API (${model}) answer to "${id}": ${why}`,
      details: { model, question: id },
    });
  if (raw === undefined) throw fail("missing");
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) throw fail(`malformed (${parsed.error.issues[0]?.message ?? "invalid"})`);
  const why = misfit(question, parsed.data);
  if (why !== undefined) throw fail(why);
  return parsed.data;
}

/**
 * The Decisions API's response, validated against the questions asked: every question answered
 * with its own type, a choice among its options, a score within its levels. Anything else is a
 * `DecisionResponseError` (`model.decision.invalid-response`). The cost is `usage.cost`.
 */
export function readDecision(raw: unknown, asked: DecisionAsked): DecisionOutcome {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DecisionResponseError({
      message: `Decisions API (${asked.model}): malformed response`,
      details: { model: asked.model },
    });
  }
  const { answers, usage, model } = parsed.data;
  const result = Object.fromEntries(
    Object.entries(asked.questions).map(([id, question]) => [
      id,
      answerOf(id, question, answers[id], asked.model),
    ]),
  );
  return {
    answers: result,
    usage: {
      caller: asked.caller,
      model: model ?? asked.model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: usage?.cost ?? 0,
      costSource: CostSource.Api,
    },
  };
}
