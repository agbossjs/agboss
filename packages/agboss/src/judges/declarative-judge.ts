import { z } from "zod";
import { runJudgeCall } from "../components/judge-call.js";
import {
  JudgeVerdict,
  type AnyJudgeInput,
  type JudgeModel,
  type RunnableJudge,
} from "../components/judge-decorators.js";
import type { JudgeBinding } from "../llm/registry.js";
import { DecisionError } from "../core/error-families/config-errors.js";
import { ModelKind } from "../llm/decision-errors.js";
import { Decision } from "../llm/decisions.js";

/**
 * The verdict of a declarative model `@Judge` (#1290): an empty class with an `output`, a `prompt` and,
 * optionally, a `threshold`. Its model reads the criterion (the prompt), the task and the answer, and
 * answers one structured verdict — a boolean `{ passed, reason }`, or with a `threshold` a score
 * `{ score, reason }` that passes when `score >= threshold`. No text of the model is parsed for a marker.
 * A chat model answers one JSON object; a decision model one `Decision.boolean` — its probability of
 * yes is the score. An answer that is not a verdict fails closed (`DecisionError.InvalidResponse`, its
 * message names the judge, never what the model said).
 */

/** The decision question a decision model answers about the criterion. */
export const JUDGE_QUESTION = "verdict";

/** What the model of a declarative judge decides on: the judge's text and its threshold. */
export interface DeclaredJudge {
  readonly name: string;
  /** The criterion, read and rendered. */
  readonly prompt: string;
  /** In `(0, 1]`: the score the answer needs; absent: the model answers pass or fail. */
  readonly threshold?: number | undefined;
  /** Which kind of model answers: a chat model (JSON) or a decision model (a probability). */
  readonly kind: ModelKind;
}

/** What it judges: the run's task and the agent's answer, as the judge's input has them. */
export interface JudgedAnswer {
  readonly task: string;
  readonly output: unknown;
}

/** The probability of yes above which a decision model passes an answer when there is no `threshold`. */
const YES = 0.5;

// not strict: a scripted pass names both fields, a model's extra key changes no verdict
const PassedAnswer = z.object({ passed: z.boolean(), reason: z.string() });
const ScoredAnswer = z.object({ score: z.number().min(0).max(1), reason: z.string() });

/** The first line of a chat judge's instructions: a scripted gateway tells a declarative judge by it. */
export const JUDGE_INSTRUCTION_LEAD =
  "You judge the answer of an AI agent against one criterion, and against nothing else.";

/** What a scripted gateway answers a declarative judge nobody scripted: the answer passes. */
export const UNSCRIPTED_JUDGE_REPLY = '{"passed":true,"score":1,"reason":""}';

/** The system message of a chat judge: the criterion and the one JSON object to answer with. */
export function judgeInstructionsOf(judge: Pick<DeclaredJudge, "prompt" | "threshold">): string {
  const shape =
    judge.threshold === undefined
      ? '{"passed": true or false, "reason": "one short sentence on what is wrong; empty when it passed"}'
      : '{"score": a number from 0 (the criterion is not met) to 1 (fully met), "reason": "one short sentence on what is wrong; empty when it is fully met"}';
  return [
    JUDGE_INSTRUCTION_LEAD,
    "",
    "Criterion:",
    judge.prompt,
    "",
    `Reply with one JSON object and nothing else: ${shape}`,
  ].join("\n");
}

/** What the answer is shown as: a text agent's text, else the DTO as JSON. */
export function answerTextOf(output: unknown): string {
  if (typeof output === "object" && output !== null) {
    const keys = Object.keys(output);
    const text: unknown = Reflect.get(output, "text");
    if (keys.length === 1 && typeof text === "string") return text;
  }
  return JSON.stringify(output, null, 2);
}

/** The user message / decision state: the task and the answer to judge. */
export const judgedTextOf = (judged: JudgedAnswer): string =>
  `Task:\n${judged.task}\n\nAnswer to judge:\n${answerTextOf(judged.output)}`;

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/u;

const invalid = (judge: string): DecisionError.InvalidResponse =>
  new DecisionError.InvalidResponse({
    message: `judge "${judge}": the model's answer is not a verdict`,
  });

/** The JSON object a chat judge's model answered, with its optional code fence taken off. */
function jsonOf(judge: string, text: string): unknown {
  const trimmed = text.trim();
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw invalid(judge);
  }
}

/** The verdict of a score: it passes at the threshold or above, its score kept for reports. */
function scoredVerdict(
  judge: Pick<DeclaredJudge, "name" | "threshold">,
  score: number,
  reason: string,
): JudgeVerdict {
  const { threshold = 1 } = judge;
  if (score >= threshold) return JudgeVerdict.passed({ metrics: { score } });
  const why =
    reason.trim() === ""
      ? `the answer scores ${String(score)}, below the threshold ${String(threshold)} of ${judge.name}`
      : reason.trim();
  return JudgeVerdict.failed(why, { metrics: { score } });
}

/** A chat judge's verdict from its model's text. */
export function chatVerdictOf(judge: DeclaredJudge, text: string): JudgeVerdict {
  const answered = jsonOf(judge.name, text);
  if (judge.threshold !== undefined) {
    const scored = ScoredAnswer.safeParse(answered);
    if (!scored.success) throw invalid(judge.name);
    return scoredVerdict(judge, scored.data.score, scored.data.reason);
  }
  const passed = PassedAnswer.safeParse(answered);
  if (!passed.success) throw invalid(judge.name);
  if (passed.data.passed) return JudgeVerdict.passed();
  const reason = passed.data.reason.trim();
  return JudgeVerdict.failed(reason === "" ? `the answer does not pass ${judge.name}` : reason);
}

/** A decision judge's verdict from the probability that the criterion holds. */
export function decisionVerdictOf(judge: DeclaredJudge, probability: number): JudgeVerdict {
  if (judge.threshold !== undefined) return scoredVerdict(judge, probability, "");
  return probability > YES
    ? JudgeVerdict.passed({ metrics: { probability } })
    : JudgeVerdict.failed(`the answer does not pass ${judge.name}`, { metrics: { probability } });
}

/**
 * One declarative judge's verdict on an answer, through the judge's metered model (its spend, its
 * reading mask and the files it read are the model's, #708, #899): a chat model is asked the criterion
 * and the answer for one JSON verdict, a decision model one yes/no question.
 */
export async function declarativeVerdictOf(
  judge: DeclaredJudge,
  judged: JudgedAnswer,
  model: JudgeModel,
): Promise<JudgeVerdict> {
  const state = judgedTextOf(judged);
  if (judge.kind === ModelKind.Decisions) {
    const { [JUDGE_QUESTION]: answer } = await model.decide({
      state,
      questions: { [JUDGE_QUESTION]: Decision.boolean(judge.prompt) },
    });
    return decisionVerdictOf(judge, answer.probability);
  }
  const text = await model.invoke([
    { role: "system", content: judgeInstructionsOf(judge) },
    { role: "user", content: state },
  ]);
  return chatVerdictOf(judge, text);
}

/** What a declarative judge decides on, as assembled: its criterion read and its threshold. */
export interface DeclaredCriterion {
  readonly prompt: string;
  readonly threshold?: number | undefined;
}

/** A judge as it is run: its code, or — a declarative one — its criterion and its model's kind. */
export interface RunnableJudgeOf {
  readonly name: string;
  readonly handler: RunnableJudge;
  readonly declared?: DeclaredCriterion | undefined;
  readonly binding?: JudgeBinding | undefined;
}

/**
 * One judge's verdict on an input, whoever runs it (an agent's quality gate, an eval check, a unit
 * test): a class with `judge(input)` decides in its own code with its metered model as `JudgeModel`;
 * a declarative judge has its model decide the criterion (#1290). A throw is a rejection.
 */
export function verdictOfJudge(
  judge: RunnableJudgeOf,
  input: AnyJudgeInput,
  model: JudgeModel,
): Promise<JudgeVerdict> {
  const { declared, binding } = judge;
  if (declared === undefined) return runJudgeCall(model, () => judge.handler.judge(input));
  if (binding === undefined) {
    return Promise.reject(new TypeError(`judge "${judge.name}": a declarative judge has a model`));
  }
  const { prompt, threshold } = declared;
  return declarativeVerdictOf(
    { name: judge.name, prompt, threshold, kind: binding.kind },
    { task: input.task, output: input.output },
    model,
  );
}
