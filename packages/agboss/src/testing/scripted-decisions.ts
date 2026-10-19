import type { DecisionOutcome } from "../llm/decision-response.js";
import {
  checkDecisionRequest,
  type ChoiceQuestion,
  type DecisionAnswer,
  type DecisionQuestion,
  type ScoreQuestion,
} from "../llm/decisions.js";
import type { DecideSpec } from "../llm/gateway.js";
import { asError, TestFailure } from "./errors.js";
import type { Clock } from "../infrastructure/clock.js";
import { nodeNameOf } from "./failure-facts.js";
import { ModelCallFailedError } from "./script.js";
import type { ScriptBook } from "./script-book.js";
import { scriptedCall, waitBeforeAnswer } from "./scripted-call.js";
import type { ScriptedAnswer, ScriptedTurn, TurnOf } from "./turns.js";

type Wrong = (why: string) => TestFailure;

/** One-hot probabilities: the scripted option certain, the others impossible. */
const certain = (options: readonly string[], picked: string): Record<string, number> =>
  Object.fromEntries(options.map((option) => [option, option === picked ? 1 : 0]));

function choiceAnswer(
  question: ChoiceQuestion,
  value: ScriptedAnswer,
  wrong: Wrong,
): DecisionAnswer {
  const options = Object.keys(question.criteria);
  if (typeof value !== "string" || !options.includes(value)) {
    throw wrong(`is a choice of ${options.join(", ")}`);
  }
  return { type: "choice", choice: value, probabilities: certain(options, value), confidence: 1 };
}

function scoreAnswer(question: ScoreQuestion, value: ScriptedAnswer, wrong: Wrong): DecisionAnswer {
  const levels = question.criteria;
  const score = typeof value === "number" ? value : levels.indexOf(value);
  if (!Number.isInteger(score) || score < 0 || score >= levels.length) {
    throw wrong(`is a score of ${levels.join(", ")}: script a level's index (0…) or its text`);
  }
  const indexes = levels.map((_, index) => String(index));
  return {
    type: "score",
    score,
    probabilities: certain(indexes, String(score)),
    legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
    confidence: 1,
  };
}

/** A scripted answer as the Decisions API would give it for its question. */
function answerOf(question: DecisionQuestion, value: ScriptedAnswer, wrong: Wrong): DecisionAnswer {
  switch (question.type) {
    case "noul":
      if (typeof value !== "number" || value < 0 || value > 1) {
        throw wrong("is a yes/no question: script P(yes), 0…1");
      }
      return { type: "noul", noul: value };
    case "choice":
      return choiceAnswer(question, value, wrong);
    case "score":
      return scoreAnswer(question, value, wrong);
  }
}

/** The answers of a `decideWith` turn: every question answered, nothing else. */
function answersOf(
  turn: Extract<ScriptedTurn, { kind: "decide" }>,
  spec: DecideSpec,
  label: string,
): DecisionOutcome["answers"] {
  const { questions } = spec.request;
  const wrongFor =
    (id: string): Wrong =>
    (why) =>
      new TestFailure("test.wrong-script", `decideWith(…) for ${label}: "${id}" ${why}`);
  const unasked = Object.keys(turn.answers).find((id) => !Object.hasOwn(questions, id));
  if (unasked !== undefined) throw wrongFor(unasked)("was not asked");
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const value = turn.answers[id];
      if (value === undefined) throw wrongFor(id)("has no scripted answer");
      return [id, answerOf(question, value, wrongFor(id))];
    }),
  );
}

/** `routeTo(…)` of a router before a launch on a decision model: yes for each target (#262 Q55). */
function routeAnswers(
  turn: TurnOf<"route">,
  spec: DecideSpec,
  label: string,
): DecisionOutcome["answers"] {
  const ids = Object.keys(spec.request.questions);
  const launched = turn.targets.map(nodeNameOf);
  const unknown = launched.filter((name) => !ids.includes(name));
  if (unknown.length > 0) {
    const message = `routeTo(${unknown.join(", ")}) for ${label}: not among the routes it launches (${ids.join(", ")})`;
    throw new TestFailure("test.not-a-route", message);
  }
  return Object.fromEntries(
    ids.map((id) => [id, { type: "noul", noul: launched.includes(id) ? 1 : 0 }] as const),
  );
}

/** The answers of a turn: `decideWith(…)`, or a launching router's `routeTo(…)`. */
function answersFor(
  turn: ScriptedTurn,
  spec: DecideSpec,
  label: string,
): DecisionOutcome["answers"] {
  if (turn.kind === "decide") return answersOf(turn, spec, label);
  if (turn.kind === "route" && spec.caller.startsWith("router:"))
    return routeAnswers(turn, spec, label);
  throw new TestFailure(
    "test.wrong-script",
    `${label} decides on ${spec.model}: script it with decideWith(…), not replyWith(…) / callTool(…) / routeTo(…)`,
  );
}

function outcomeOf(turn: ScriptedTurn, spec: DecideSpec, label: string): DecisionOutcome {
  if (turn.kind === "failure") throw new ModelCallFailedError(turn.failure, label);
  const cost = turn.kind === "decide" || turn.kind === "route" ? turn.details.cost : undefined;
  return {
    answers: answersFor(turn, spec, label),
    usage: {
      caller: spec.caller,
      model: spec.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: cost ?? 0,
      costSource: "api",
    },
  };
}

/**
 * A decision in a test — a judge's, a model arbiter's, a router's before a launch: answered by its
 * script (`mockLlm(Judge).thenReturn(decideWith(…))`), the request recorded, after its
 * `waitFor(…)`. A script that does not fit the questions fails the test.
 */
export async function scriptedDecide(
  book: ScriptBook,
  clock: Clock,
  spec: DecideSpec,
): Promise<DecisionOutcome> {
  const script = book.scriptOf(spec.caller);
  const { state, questions } = spec.request;
  const input = typeof state === "string" ? state : JSON.stringify(state);
  try {
    const request = { kind: "decide", input, state, questions } as const;
    const call = scriptedCall(script, request, () => {
      checkDecisionRequest(spec.request);
    });
    await waitBeforeAnswer(clock, call);
    return outcomeOf(call.turn, spec, script.label);
  } catch (error) {
    if (error instanceof TestFailure) book.report(error);
    throw asError(error);
  }
}
