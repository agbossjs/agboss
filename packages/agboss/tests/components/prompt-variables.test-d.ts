import { describe, expectTypeOf, it } from "vitest";
import { defineEnv, env, secret, type EnvRef, type PromptVariables } from "../../src/index.js";

/** #1347c: a prompt variable is a text or an `EnvRef<string>`; a secret does not compile. */
const appEnv = defineEnv({
  company: env("COMPANY"),
  apiKey: secret("API_KEY"),
  limit: env.integer("LIMIT"),
});

describe("#1347c: PromptVariables", () => {
  it("takes texts and string references", () => {
    expectTypeOf<PromptVariables>().toEqualTypeOf<
      Readonly<Record<string, string | EnvRef<string>>>
    >();
    expectTypeOf({ company: "Acme", name: appEnv.company }).toExtend<PromptVariables>();
  });

  it("refuses a secret and a number", () => {
    // @ts-expect-error a secret never reaches a prompt
    const secretVariables: PromptVariables = { key: appEnv.apiKey };
    // @ts-expect-error a number is not a text
    const numberVariables: PromptVariables = { limit: appEnv.limit };
    expectTypeOf([secretVariables, numberVariables]).not.toBeAny();
  });
});
