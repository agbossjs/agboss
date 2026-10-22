/**
 * #383 — code guardrails at run time: `decidedBy: DecidedBy.Code` decides by the class's
 * `check(text)` on the text the model reads (masked); `GuardrailVerdict.blocked()` fails the
 * execution with the same `GuardrailBlockedError` and the refusal (static or computed); the
 * levels and `excludeGuardrails` work as for a model guardrail; no model call, no spend.
 */
import { describe, expect } from "vitest";
import { GuardFailedError, GuardrailBlockedError } from "../../src/index.js";
import { decideWith, replyWith, routeTo, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  BlocklistService,
  FragileAgent,
  guardrailEvents,
  NotesAgent,
  PromptInjectionGuardrail,
  SalesAgent,
  ShopApplication,
  ShopRouter,
  ShopStart,
} from "./code-guardrails.fixture.js";

const test = testWith(ShopApplication);

const toys = { tenant: { tenantId: "acme", shop: "toys" }, execution: { locale: "en" } } as const;

describe("#383: a code guardrail blocks with the same error and its refusal", () => {
  test("an output code guardrail blocks the answer: the decorator's refusal, probability 1", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ShopRouter).thenReturn(routeTo(SalesAgent));
    mockLlm(SalesAgent).thenReturn(replyWith("Our best knife is on sale."));

    const run = execute(app, ShopStart, { text: "What is on sale?" }, toys);

    await expect(run).rejects.toFailWith(GuardrailBlockedError, {
      code: "guardrail.blocked",
      guard: "tenant-blocklist-guardrail",
      refusal: "The response contained restricted terms.",
      probability: 1,
      threshold: 1,
    });
  });

  test("an input code guardrail blocks before the router's model: the class's refusal, in the sender's language", async ({
    app,
    mockLlm,
  }) => {
    const run = execute(
      app,
      ShopStart,
      { text: "My card is 4242 4242 4242 4242" },
      { ...toys, execution: { locale: "he" } },
    );

    await expect(run).rejects.toFailWith(GuardrailBlockedError, {
      guard: "card-number-guardrail",
      refusal: "אל תשלחו מספרי כרטיס.",
    });
    expect(mockLlm(ShopRouter)).toHaveBeenCalledTimes(0);
  });

  test("passed: the execution goes on, the code guardrails cost nothing", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ShopRouter).thenReturn(routeTo(SalesAgent));
    mockLlm(PromptInjectionGuardrail).thenReturn(decideWith({ blocks: 0.1 }));
    mockLlm(SalesAgent).thenReturn(replyWith("A teddy bear."));

    const result = await execute(app, ShopStart, { text: "A gift for a child?" }, toys);

    expect(result.output).toEqual({ text: "A teddy bear." });
    expect(result.spend.trace.map((line) => line.caller)).not.toContain(
      "guardrail:tenant-blocklist-guardrail",
    );
    expect(result.spend.trace.map((line) => line.caller)).not.toContain(
      "guardrail:card-number-guardrail",
    );
  });

  test("a check that throws fails closed: GuardFailedError with the error as its cause", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ShopRouter).thenReturn(routeTo(FragileAgent));

    const run = execute(app, ShopStart, { text: "Hello" }, toys);

    await expect(run).rejects.toFailWith(GuardFailedError, {
      code: "step.guard",
      guard: "broken-guardrail",
      message: 'Guard "broken-guardrail" failed: the blocklist is unreachable',
      cause: Error,
    });
    expect(mockLlm(FragileAgent)).toHaveBeenCalledTimes(0);
  });
});

describe("#383: check(text) reads the masked text, on the levels that list it", () => {
  test("the output guardrail reads the answer masked: a token, never the address", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    const blocklist = mockOf(BlocklistService);
    blocklist.containsBlockedTerms.mockResolvedValue(false);
    mockLlm(ShopRouter).thenReturn(routeTo(SalesAgent));
    mockLlm(PromptInjectionGuardrail).thenReturn(decideWith({ blocks: 0.1 }));
    mockLlm(SalesAgent).thenReturn(replyWith("We will write to bob@example.com."));

    await execute(app, ShopStart, { text: "Contact me." }, toys);

    const [[shop, text]] = blocklist.containsBlockedTerms.mock.calls as [
      ["toys" | "tools", string],
    ];
    expect(shop).toBe("toys");
    expect(text).not.toContain("bob@example.com");
    expect(text).toMatch(/<email:[0-9a-f]+>/);
  });

  test("excludeGuardrails: the notes agent's answer and input are checked by none of them", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(BlocklistService); // spied from the start: its calls are read after the execution
    mockLlm(ShopRouter).thenReturn(routeTo(NotesAgent));
    mockLlm(NotesAgent).thenReturn(replyWith("Knife order noted."));

    const result = await execute(app, ShopStart, { text: "Note my knife order." }, toys);

    expect(result.output).toEqual({ text: "Knife order noted." });
    expect(mockOf(BlocklistService).containsBlockedTerms.mock.calls).toEqual([]);
  });
});

describe("#383: observers see a code guardrail's decision", () => {
  test("onGuardrailStart / onGuardrailEnd fire with the masked text; a pass is probability 0", async ({
    app,
    mockLlm,
  }) => {
    guardrailEvents.length = 0;
    mockLlm(ShopRouter).thenReturn(routeTo(NotesAgent));
    mockLlm(NotesAgent).thenReturn(replyWith("Noted."));

    await execute(app, ShopStart, { text: "Call me at bob@example.com." }, toys);

    const [started, ended] = guardrailEvents;
    expect(started).toMatchObject({
      name: "card-number-guardrail",
      input: { side: "input", element: "shop-router" },
    });
    expect(started !== undefined && "input" in started ? started.input.text : "").toMatch(
      /<email:[0-9a-f]+>/,
    );
    expect(ended).toMatchObject({
      name: "card-number-guardrail",
      update: { isBlocked: false, probability: 0 },
    });
  });
});
