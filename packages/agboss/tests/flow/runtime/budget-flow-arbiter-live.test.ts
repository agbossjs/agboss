/**
 * #1356 (budget-flow shard) — the injected `ArbiterModel` of a code arbiter: it is the model of the arbiter whose
 * `@Arbitrate` method runs now, one per async context, and nothing outside one.
 */
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../../src/core/error-families/config-errors.js";
import { LiveArbiterModel, runArbiterCall } from "../../../src/flow/runtime/launch/arbiter-live.js";
import type { ArbiterModel } from "../../../src/flow/decorators/arbiter.js";

const modelOf = (name: string) => {
  const decide = vi.fn(() => Promise.resolve({ answered: name }));
  const arbiter = {
    model: name,
    invoke: (input: unknown) => Promise.resolve(`${name} says ${JSON.stringify(input)}`),
    decide,
  } as unknown as ArbiterModel;
  return { arbiter, decide };
};

describe("#1356: the model of the arbiter that runs now", () => {
  it("is the model, the chat call and the decision of the method's own arbiter, and the instance is frozen", async () => {
    const live = new LiveArbiterModel("desk-arbiter");
    const { arbiter: own, decide } = modelOf("own-model");

    const seen = await runArbiterCall(own, async () => ({
      model: live.model,
      text: await live.invoke("hi"),
      decided: await live.decide({ state: "s", questions: {} }),
    }));

    expect(seen).toEqual({
      model: "own-model",
      text: 'own-model says "hi"',
      decided: { answered: "own-model" },
    });
    expect(decide).toHaveBeenCalledWith({ state: "s", questions: {} });
    expect(Object.isFrozen(live)).toBe(true);
  });

  it("arbiters of parallel branches never mix: each method reads its own", async () => {
    const live = new LiveArbiterModel("desk-arbiter");
    const slow = runArbiterCall(modelOf("first").arbiter, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return live.model;
    });
    const quick = runArbiterCall(modelOf("second").arbiter, () => live.model);

    expect(await Promise.all([slow, quick])).toEqual(["first", "second"]);
  });

  it.each([
    ["model", (live: LiveArbiterModel) => live.model],
    ["invoke", (live: LiveArbiterModel) => live.invoke("x")],
    ["decide", (live: LiveArbiterModel) => live.decide({ state: "s", questions: {} })],
  ])(
    "%s outside an @Arbitrate method is ConfigError.Component, naming the consumer and the member",
    (member, use) => {
      const live = new LiveArbiterModel("desk-arbiter");
      let failure: unknown;
      try {
        void use(live);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ConfigError.Component);
      expect((failure as Error).message).toBe(
        `[arbiter.model-outside-arbiter] desk-arbiter used arbiterModel.${member} outside an @Arbitrate method — inject ArbiterModel only into an @Arbiter and call it from its @Arbitrate methods`,
      );
    },
  );
});
