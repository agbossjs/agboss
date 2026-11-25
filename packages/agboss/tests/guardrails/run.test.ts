/**
 * #120 PR 2 — guardrails at run time (AC1, AC2, AC4, S84 i): an input guardrail checks what an
 * agent's or a model router's model reads, masked by its PII policies, before that model is
 * called; an output guardrail checks what an agent answered. A hit at or above the threshold fails
 * the execution with `GuardrailBlockedError` and its refusal; a model that does not answer fails
 * closed.
 */
import { describe, expect } from "vitest";
import { GuardFailedError, GuardrailBlockedError } from "../../src/index.js";
import {
  decideWith,
  failWith,
  ModelFailure,
  replyWith,
  routeTo,
  testWith,
} from "../../src/testing/index.js";
import type { ModelRequest } from "../../src/testing/model-script.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  AdviceAgent,
  ClinicApplication,
  ClinicStart,
  LegalAdviceGuardrail,
  NoLegalAdviceGuardrail,
  NotesAgent,
  PromptInjectionGuardrail,
  TriageRouter,
} from "./guardrails.fixture.js";

const test = testWith(ClinicApplication);

const english = { execution: { locale: "en" } } as const;

/** What a guardrail's model was asked: the text it read, under its heading. */
const inputsOf = (requests: readonly ModelRequest[]): string[] =>
  requests.map((request) =>
    typeof request.input === "string" ? request.input : JSON.stringify(request.input),
  );

describe("#120 AC1, AC2: a guardrail blocks with its refusal", () => {
  test("an input guardrail blocks before the agent's model: the class's refusal, in the sender's language", async ({
    app,
    mockModel,
  }) => {
    mockModel(TriageRouter).thenReturn(routeTo(AdviceAgent));
    mockModel(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.9 }));

    const run = execute(
      app,
      ClinicStart,
      { text: "Can I sue my landlord?" },
      { execution: { locale: "he" } },
    );

    await expect(run).rejects.toFailWith(GuardrailBlockedError, {
      code: "guardrail.blocked",
      guard: "legal-advice-guardrail",
      refusal: "אני לא נותן ייעוץ משפטי.",
      key: "guardrails.legal-advice-guardrail.threshold",
      probability: 0.9,
      threshold: 0.8,
    });
    expect(mockModel(AdviceAgent)).toHaveBeenCalledTimes(0);
  });

  test("an output guardrail blocks the answer: the decorator's refusal", async ({
    app,
    mockModel,
  }) => {
    mockModel(TriageRouter).thenReturn(routeTo(AdviceAgent));
    mockModel(AdviceAgent).thenReturn(replyWith("Sue them under section 12."));
    mockModel(NoLegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.95 }));

    const run = execute(app, ClinicStart, { text: "My landlord kept my deposit." }, english);

    await expect(run).rejects.toFailWith(GuardrailBlockedError, {
      guard: "no-legal-advice-guardrail",
      refusal: "I can't give legal advice. Please contact a lawyer.",
    });
    expect(inputsOf(mockModel(NoLegalAdviceGuardrail).requests)).toEqual([
      expect.stringContaining("### answer (from advice-agent)\nSue them under section 12."),
    ]);
  });

  test("below the threshold the execution goes on; the guardrails' spend is the execution's", async ({
    app,
    mockModel,
  }) => {
    mockModel(TriageRouter).thenReturn(routeTo(AdviceAgent));
    mockModel(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.79 }, { cost: usd(0.001) }));
    mockModel(AdviceAgent).thenReturn(replyWith("Drink water."));

    const result = await execute(app, ClinicStart, { text: "I have a headache." }, english);

    expect(result.output).toEqual({ text: "Drink water." });
    expect(result.spend.byCategory.guardrails).toBeCloseTo(0.001, 9);
    expect(result.spend.trace.map((line) => line.caller)).toContain(
      "guardrail:legal-advice-guardrail",
    );
  });

  test("a guardrail's model that does not answer fails closed: GuardFailedError", async ({
    app,
    mockModel,
  }) => {
    mockModel(PromptInjectionGuardrail).thenReturn(failWith(ModelFailure.Timeout));

    const run = execute(app, ClinicStart, { text: "Hello" }, english);

    await expect(run).rejects.toFailWith(GuardFailedError, { code: "step.guard" });
    expect(mockModel(TriageRouter)).toHaveBeenCalledTimes(0);
  });
});

describe("#120 AC4: levels — lists add up, a router takes input guardrails, exclude removes", () => {
  test("the router: the application's input guardrail; the agent: application + own + workflow's output", async ({
    app,
    mockModel,
  }) => {
    mockModel(TriageRouter).thenReturn(routeTo(AdviceAgent));
    mockModel(AdviceAgent).thenReturn(replyWith("Rest."));

    await execute(app, ClinicStart, { text: "I feel tired." }, english);

    expect(inputsOf(mockModel(PromptInjectionGuardrail).requests)).toEqual([
      expect.stringContaining("### message (to triage-router)"),
      expect.stringContaining("### message (to advice-agent)"),
    ]);
    expect(mockModel(LegalAdviceGuardrail).requests).toHaveLength(1);
    expect(inputsOf(mockModel(NoLegalAdviceGuardrail).requests)).toEqual([
      expect.stringContaining("### answer (from advice-agent)"),
    ]);
  });

  test("excludeGuardrails: the notes agent's model is guarded by none of the excluded ones", async ({
    app,
    mockModel,
  }) => {
    mockModel(TriageRouter).thenReturn(routeTo(NotesAgent));
    mockModel(NotesAgent).thenReturn(replyWith("Noted."));

    await execute(app, ClinicStart, { text: "Please call me back." }, english);

    expect(inputsOf(mockModel(PromptInjectionGuardrail).requests)).toEqual([
      expect.stringContaining("### message (to triage-router)"),
    ]);
    expect(mockModel(NoLegalAdviceGuardrail).requests).toEqual([]);
  });
});

describe("#120 S84 (i): a guardrail reads the text behind the model boundary", () => {
  test("it reads the masked input message: a token, never the address", async ({
    app,
    mockModel,
  }) => {
    mockModel(TriageRouter).thenReturn(routeTo(AdviceAgent));
    mockModel(AdviceAgent).thenReturn(replyWith("We will write to you."));

    await execute(app, ClinicStart, { text: "Write to alice@example.com please." }, english);

    const [toRouter, toAgent] = inputsOf(mockModel(PromptInjectionGuardrail).requests);
    for (const input of [toRouter, toAgent]) {
      expect(input).not.toContain("alice@example.com");
      expect(input).toMatch(/<email:[0-9a-f]+>/);
    }
  });
});
