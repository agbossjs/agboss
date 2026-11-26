/**
 * #266 S90, #1324b: `env.optional("X")`, `env.integer.optional("X")`, `env.boolean.optional("X")` — a
 * variable that may be unset. Unset (or empty) is `undefined`, not a missing variable; a set value is
 * still checked; the process variables `agboss check` lists mark it optional.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineEnv, resolveEnv } from "../../src/environments/define-env.js";
import { processVariableOf, VariableUse } from "../../src/environments/process-variable.js";
import { env } from "../../src/index.js";

const optionalEnv = defineEnv({
  region: env.optional("REGION"),
  port: env.integer.optional("PORT"),
  debug: env.boolean.optional("DEBUG"),
});

const resolved = (processEnv: NodeJS.ProcessEnv): Readonly<Record<string, unknown>> =>
  resolveEnv(optionalEnv, processEnv);

describe("#266 S90: optional environment variables", () => {
  it("each reader is typed as its value or undefined", () => {
    expectTypeOf(env.optional("REGION")).toExtend<string | undefined>();
    expectTypeOf(env.integer.optional("PORT")).toExtend<number | undefined>();
    expectTypeOf(env.boolean.optional("DEBUG")).toExtend<boolean | undefined>();
    expect(resolved({})).toEqual({ region: undefined, port: undefined, debug: undefined });
  });

  it("unset or empty → undefined, never a missing variable", () => {
    expect(resolved({})).toEqual({ region: undefined, port: undefined, debug: undefined });
    expect(resolved({ REGION: "", PORT: "", DEBUG: "" })).toEqual({
      region: undefined,
      port: undefined,
      debug: undefined,
    });
  });

  it("set → its value, parsed by its kind", () => {
    expect(resolved({ REGION: "eu-west-1", PORT: "8080", DEBUG: "true" })).toEqual({
      region: "eu-west-1",
      port: 8080,
      debug: true,
    });
  });

  it("a set value is still checked: an integer or a boolean that does not parse fails, naming the variable", () => {
    const failure = (processEnv: NodeJS.ProcessEnv): unknown => {
      try {
        resolved(processEnv);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const integer = failure({ PORT: "eighty" });
    expect(integer).toBeInstanceOf(ConfigError.Environment);
    expect(integer).toMatchObject({
      message: "[environment.invalid-value] PORT is not an integer (port)",
    });
    expect(failure({ DEBUG: "maybe" })).toMatchObject({
      message: "[environment.invalid-value] DEBUG is not a flag (true, false, 1, 0) (debug)",
    });
  });

  it("a required env(…) next to it still fails when unset", () => {
    const mixed = defineEnv({ region: env.optional("REGION"), url: env("URL") });

    expect(() => resolveEnv(mixed, {})).toThrow(
      "[environment.missing-variable] URL is not set (url)",
    );
  });

  it("agboss check: not required, marked optional", () => {
    expect(
      Object.entries(optionalEnv).map(([field, reference]) =>
        processVariableOf(field, reference as never),
      ),
    ).toEqual([
      {
        variable: "REGION",
        field: "region",
        use: VariableUse.Value,
        required: false,
        optional: true,
      },
      { variable: "PORT", field: "port", use: VariableUse.Value, required: false, optional: true },
      {
        variable: "DEBUG",
        field: "debug",
        use: VariableUse.Value,
        required: false,
        optional: true,
      },
    ]);
  });
});
