/**
 * #261 PR 4 (AC9), #1324b: a secret is set only with `secret("X")` from a process variable; it
 * prints as `***` everywhere — logs, JSON (traces), errors, `agboss describe` — and only `.reveal()`
 * gives the value.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { defineEnv, resolveEnv } from "../../src/environments/define-env.js";
import { processVariableOf, VariableUse } from "../../src/environments/process-variable.js";
import { Secret, env, secret } from "../../src/index.js";

const VALUE = "s3cret-value";

const appEnv = defineEnv({
  apiToken: secret("FIXTURE_API_TOKEN"),
  currency: env("FIXTURE_CURRENCY"),
  timeoutSeconds: env.integer("FIXTURE_TIMEOUT", { default: 30 }),
});

const PROCESS = { FIXTURE_API_TOKEN: VALUE, FIXTURE_CURRENCY: "EUR" };

describe("#261 AC9: *** everywhere, reveal()", () => {
  it("reveal() gives the value of the process variable", () => {
    expect(resolveEnv(appEnv, PROCESS).apiToken.reveal()).toBe(VALUE);
  });

  it("prints as *** in strings, logs, JSON and error messages", () => {
    const token = resolveEnv(appEnv, PROCESS).apiToken;

    expect(String(token)).toBe("***");
    expect(`Bearer ${String(token)}`).toBe("Bearer ***");
    expect(inspect({ token })).toBe("{ token: *** }");
    expect(JSON.stringify({ token })).toBe('{"token":"***"}');
    expect(new Error(`failed with ${String(token)}`).message).not.toContain(VALUE);
  });

  it("the whole resolved environment prints without the value", () => {
    const values = resolveEnv(appEnv, PROCESS);

    expect(JSON.stringify(values)).not.toContain(VALUE);
    expect(inspect(values)).not.toContain(VALUE);
  });

  it("a secret reference is not resolved: reveal() names where to read it", () => {
    expect(() => secret("X").reveal()).toThrow(ConfigError.Environment);
    expect(() => secret("X").reveal()).toThrow(
      /\[environment\.missing-variable\] .*not resolved: read it from the application's defineEnv values/,
    );
  });

  it("a missing secret fails naming the variable, never a value", () => {
    const failure = (() => {
      try {
        resolveEnv(appEnv, { FIXTURE_CURRENCY: "EUR", OTHER: VALUE });
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(failure).toBeInstanceOf(ConfigError.Environment);
    expect((failure as Error).message).toBe(
      "[environment.missing-variable] FIXTURE_API_TOKEN is not set (apiToken)",
    );
    expect((failure as Error).message).not.toContain(VALUE);
  });

  it("agboss check lists the process variables, marked value / secret", () => {
    expect(
      Object.entries(appEnv).map(([field, reference]) =>
        processVariableOf(field, reference as never),
      ),
    ).toEqual([
      {
        variable: "FIXTURE_API_TOKEN",
        field: "apiToken",
        use: VariableUse.Secret,
        required: true,
        optional: false,
      },
      {
        variable: "FIXTURE_CURRENCY",
        field: "currency",
        use: VariableUse.Value,
        required: true,
        optional: false,
      },
      {
        variable: "FIXTURE_TIMEOUT",
        field: "timeoutSeconds",
        use: VariableUse.Value,
        required: false,
        optional: false,
      },
    ]);
  });

  it("a literal in a secret slot does not compile, nor a Secret where a string is expected", () => {
    // never run: a JavaScript caller's literal is refused at `defineEnv` too
    // @ts-expect-error — a secret comes only from a process variable: secret("X")
    const literal = () => defineEnv({ apiToken: "hardcoded" });
    // @ts-expect-error — a Secret is not a string: reveal() it where the value is used
    const asText: string = secret("TOKEN");
    expect([literal, asText]).toHaveLength(2);
    expect(literal).toThrow(/no env\(…\) or secret\(…\) reference/);
    expect(Secret).toBeDefined();
  });
});
