import { DecisionRequestError } from "./decision-errors.js";

/** How closely a decision model looks at an image (`Auto` when omitted, #269). */
export enum ImageDetail {
  Auto = "auto",
  Low = "low",
  High = "high",
}

/** An image in a decision's state: a data URL (png, jpeg or webp), sent as a top-level part. */
export interface DecisionImage {
  readonly type: "image_url";
  readonly image_url: { readonly url: string; readonly detail?: ImageDetail };
}

/** What a decision is made about: a text, a JSON object, or text and image parts. */
export type DecisionState =
  string | Readonly<Record<string, unknown>> | readonly (string | DecisionImage)[];

/** Pick one option; each option's description (or `null`) tells the model what it means. */
export interface ChoiceQuestion<O extends string = string> {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<O, string | null>>;
}

/** Yes or no: the answer is P(yes). */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
}

/** A level on a scale, lowest first: the answer is the level's index. */
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type DecisionQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

/** Questions of one decision by id. */
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

export interface ChoiceAnswer<O extends string = string> {
  readonly type: "choice";
  readonly choice: O;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly type: "noul";
  /** P(yes), 0…1. */
  readonly noul: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  /** The index of the level, 0 = the lowest. */
  readonly score: number;
  /** By level index (`"0"`, `"1"`, …). */
  readonly probabilities: Readonly<Record<string, number>>;
  /** Each level index's text. */
  readonly legend: Readonly<Record<string, string>>;
  readonly confidence: number;
}

export type DecisionAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** The answer a question gets: a choice among its options, P(yes), or a level. */
export type AnswerOf<Q> =
  Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends NoulQuestion
      ? NoulAnswer
      : Q extends ScoreQuestion
        ? ScoreAnswer
        : never;

/** Every question's answer, by the question's id. */
export type AnswersOf<Q extends DecisionQuestions> = { readonly [K in keyof Q]: AnswerOf<Q[K]> };

/** One `decide` call: the state and the questions about it. */
export interface DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> {
  readonly state: DecisionState;
  readonly questions: Q;
}

/** The Decisions API's limit of questions per call. */
export const MAX_DECISION_QUESTIONS = 200;

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,/;

/**
 * Builders of decision questions (`ctx.model.decide({ state, questions })`) and image parts of a
 * state; the answers are typed from them.
 */
export const Decision = {
  choice<const C extends Readonly<Record<string, string | null>>>(
    instructions: string,
    criteria: C,
  ): ChoiceQuestion<keyof C & string> {
    if (Object.keys(criteria).length < 2) {
      throw new DecisionRequestError({
        message: `Decision.choice("${instructions}"): needs at least 2 options`,
      });
    }
    return { type: "choice", instructions, criteria };
  },

  noul(
    instructions: string,
    criteria?: { readonly true: string; readonly false: string },
  ): NoulQuestion {
    return criteria === undefined
      ? { type: "noul", instructions }
      : { type: "noul", instructions, criteria };
  },

  score(instructions: string, levels: readonly string[]): ScoreQuestion {
    if (levels.length < 2) {
      throw new DecisionRequestError({
        message: `Decision.score("${instructions}"): needs at least 2 levels`,
      });
    }
    return { type: "score", instructions, criteria: [...levels] };
  },

  image(dataUrl: string, detail?: ImageDetail): DecisionImage {
    if (!IMAGE_DATA_URL.test(dataUrl)) {
      throw new DecisionRequestError({
        message:
          "Decision.image: only data URLs of png, jpeg or webp images (data:image/png;base64,…)",
      });
    }
    return {
      type: "image_url",
      image_url: detail === undefined ? { url: dataUrl } : { url: dataUrl, detail },
    };
  },
} as const;

/** The checks the Decisions API would fail a request with, made before the call. */
export function checkDecisionRequest(request: DecisionRequest): void {
  const count = Object.keys(request.questions).length;
  if (count === 0)
    throw new DecisionRequestError({ message: "a decision needs at least one question" });
  if (count > MAX_DECISION_QUESTIONS) {
    throw new DecisionRequestError({
      message: `${String(count)} questions in one decision: the Decisions API takes at most ${String(MAX_DECISION_QUESTIONS)}`,
      details: { count, max: MAX_DECISION_QUESTIONS },
    });
  }
}
