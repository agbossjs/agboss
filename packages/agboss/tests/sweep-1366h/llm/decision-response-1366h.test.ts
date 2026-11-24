/**
 * #1366: a Decisions API response is accepted only when every answer has its question's type, a choice among its
 * options, a score within its levels and probabilities within 0..1; a refusal is a DecisionError.InvalidResponse
 * (`model.decision.invalid-response`) naming the model and the question; the usage keeps the response's model and tokens.
 */
import { describe, expect, it } from "vitest";
import { Decision } from "../../../src/llm/decisions.js";
import { readDecision } from "../../../src/llm/decision-response.js";
import { DecisionError } from "../../../src/index.js";

const probs = { a: 0.5, b: 0.5 };
const choiceQ = Decision.choice("pick", { a: null, b: null });
const scoreQ = Decision.score("rate", ["low", "mid", "high"]);
const booleanQ = Decision.boolean("is it?");

function refusal(raw: unknown, questions: Parameters<typeof readDecision>[1]["questions"]) {
  try {
    readDecision(raw, { caller: "c", model: "m1", questions });
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("#1366: readDecision validation", () => {
  it("accepts one valid answer of each type, with the response's model and tokens", () => {
    const read = readDecision(
      {
        model: "m2",
        answers: {
          c: { type: "choice", choice: "a", probabilities: probs, confidence: 0.9 },
          s: {
            type: "score",
            score: 2,
            probabilities: { "2": 1 },
            legend: { "2": "high" },
            confidence: 1,
          },
          n: { type: "boolean", probability: 0.5 },
        },
        usage: { input_tokens: 7, output_tokens: 3, cost: 0.5 },
      },
      { caller: "c", model: "m1", questions: { c: choiceQ, s: scoreQ, n: booleanQ } },
    );
    expect(read.answers.c).toMatchObject({ type: "choice", choice: "a" });
    expect(read.answers.s).toMatchObject({ type: "score", score: 2 });
    expect(read.answers.n).toMatchObject({ type: "boolean", probability: 0.5 });
    expect(read.usage).toMatchObject({
      model: "m2",
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0.5,
    });
  });

  it("falls back to the asked model and zero tokens when the response states none", () => {
    const read = readDecision(
      { answers: { n: { type: "boolean", probability: 1 } } },
      { caller: "c", model: "m1", questions: { n: booleanQ } },
    );
    expect(read.usage).toMatchObject({ model: "m1", inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(read.answers.n).toMatchObject({ probability: 1 });
  });

  it("accepts the edges: a boolean 0, probabilities 0 and 1, the last score level", () => {
    expect(() =>
      readDecision(
        {
          answers: {
            n: { type: "boolean", probability: 0 },
            c: { type: "choice", choice: "b", probabilities: { a: 0, b: 1 }, confidence: 1 },
            s: { type: "score", score: 2, probabilities: { "2": 1 }, legend: {}, confidence: 1 },
          },
        },
        { caller: "c", model: "m1", questions: { n: booleanQ, c: choiceQ, s: scoreQ } },
      ),
    ).not.toThrow();
  });

  it("refuses a response that is not an object with answers, naming the model", () => {
    const e = refusal({ nope: 1 }, { n: booleanQ });
    expect(e).toBeInstanceOf(DecisionError.InvalidResponse);
    expect(e).toMatchObject({ code: "model.decision.invalid-response", details: { model: "m1" } });
    expect(refusal({ answers: {}, usage: { cost: "x" } }, {})).toBeInstanceOf(
      DecisionError.InvalidResponse,
    );
  });

  it("refuses an answer to a question of another type", () => {
    for (const [q, a] of [
      [booleanQ, { type: "choice", choice: "a", probabilities: probs, confidence: 1 }],
      [choiceQ, { type: "boolean", probability: 0.5 }],
      [scoreQ, { type: "boolean", probability: 0.5 }],
    ] as const) {
      const e = refusal({ answers: { q: a } }, { q });
      expect(e).toBeInstanceOf(DecisionError.InvalidResponse);
      expect(e).toMatchObject({
        code: "model.decision.invalid-response",
        details: { model: "m1", question: "q" },
      });
    }
  });

  it("refuses a choice that is not an option, a score past the levels", () => {
    const c = refusal(
      { answers: { q: { type: "choice", choice: "zzz", probabilities: probs, confidence: 1 } } },
      { q: choiceQ },
    );
    expect(c).toMatchObject({
      code: "model.decision.invalid-response",
      details: { model: "m1", question: "q" },
    });
    const proto = refusal(
      {
        answers: { q: { type: "choice", choice: "toString", probabilities: probs, confidence: 1 } },
      },
      { q: choiceQ },
    );
    expect(proto).toBeInstanceOf(DecisionError.InvalidResponse);
    for (const score of [3, 4]) {
      const s = refusal(
        { answers: { q: { type: "score", score, probabilities: {}, legend: {}, confidence: 1 } } },
        { q: scoreQ },
      );
      expect(s).toMatchObject({
        code: "model.decision.invalid-response",
        details: { model: "m1", question: "q" },
      });
    }
  });

  it("refuses a missing answer apart from a malformed one", () => {
    const missing = refusal({ answers: {} }, { q: booleanQ });
    expect(missing).toMatchObject({
      code: "model.decision.invalid-response",
      details: { model: "m1", question: "q" },
    });
    expect((missing as Error).message).toMatch(/missing/);
    const bad = refusal({ answers: { q: { type: "boolean" } } }, { q: booleanQ });
    expect(bad).toBeInstanceOf(DecisionError.InvalidResponse);
    expect((bad as Error).message).not.toMatch(/missing/);
    expect((bad as Error).message).toMatch(/malformed/);
  });

  it("refuses probabilities outside 0..1, a negative or fractional score", () => {
    const bads: [Parameters<typeof refusal>[1], unknown][] = [
      [{ q: booleanQ }, { type: "boolean", probability: 1.5 }],
      [{ q: booleanQ }, { type: "boolean", probability: -0.5 }],
      [{ q: choiceQ }, { type: "choice", choice: "a", probabilities: { a: 1.5 }, confidence: 1 }],
      [{ q: choiceQ }, { type: "choice", choice: "a", probabilities: { a: -0.5 }, confidence: 1 }],
      [
        { q: scoreQ },
        { type: "score", score: 1, probabilities: { x: 2 }, legend: {}, confidence: 1 },
      ],
      [{ q: scoreQ }, { type: "score", score: -1, probabilities: {}, legend: {}, confidence: 1 }],
      [{ q: scoreQ }, { type: "score", score: 0.5, probabilities: {}, legend: {}, confidence: 1 }],
    ];
    for (const [qs, a] of bads) {
      expect(refusal({ answers: { q: a } }, qs)).toBeInstanceOf(DecisionError.InvalidResponse);
    }
  });
});
