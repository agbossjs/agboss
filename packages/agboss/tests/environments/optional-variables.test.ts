/**
 * #266 S90: `env.optional("X")`, `env.integer.optional("X")`, `env.flag.optional("X")` — a variable
 * that may be unset. Unset (or empty) is `undefined`, not a missing variable; a set value is still
 * checked; `agboss check --env` and `agboss describe` mark it optional.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { EnvironmentError, EnvironmentErrorCode } from "../../src/environments/errors.js";
import {
  describedEnvironment,
  environmentVariablesOf,
  resolveEnvironment,
  VariableUse,
} from "../../src/environments/resolve.js";
import { env } from "../../src/index.js";

const loaded = {
  name: "dev",
  contract: "C",
  values: {
    region: env.optional("REGION"),
    port: env.integer.optional("PORT"),
    debug: env.flag.optional("DEBUG"),
  },
};

const resolved = (processEnv: NodeJS.ProcessEnv): Readonly<Record<string, unknown>> => {
  const values = resolveEnvironment(loaded, processEnv);
  return {
    region: Reflect.get(values, "region"),
    port: Reflect.get(values, "port"),
    debug: Reflect.get(values, "debug"),
  };
};

describe("#266 S90: optional environment variables", () => {
  it("each reader is typed as its value or undefined", () => {
    expectTypeOf(env.optional("REGION")).toEqualTypeOf<string | undefined>();
    expectTypeOf(env.integer.optional("PORT")).toEqualTypeOf<number | undefined>();
    expectTypeOf(env.flag.optional("DEBUG")).toEqualTypeOf<boolean | undefined>();
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

  it("a set value is still checked: an integer or a flag that does not parse fails", () => {
    const failure = (processEnv: NodeJS.ProcessEnv): unknown => {
      try {
        resolveEnvironment(loaded, processEnv);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const integer = failure({ PORT: "eighty" });
    expect(integer).toBeInstanceOf(EnvironmentError);
    expect(integer).toMatchObject({
      code: EnvironmentErrorCode.InvalidValue,
      message: "PORT is not an integer (C.port, dev)",
    });
    expect(failure({ DEBUG: "maybe" })).toMatchObject({
      code: EnvironmentErrorCode.InvalidValue,
      message: "DEBUG is not a flag (true, false, 1, 0) (C.debug, dev)",
    });
  });

  it("a required env(…) next to it still fails when unset", () => {
    const mixed = { ...loaded, values: { ...loaded.values, url: env("URL") } };
    expect(() => resolveEnvironment(mixed, {})).toThrow("URL is not set (C.url, dev)");
  });

  it("agboss check --env: not required, marked optional", () => {
    expect(environmentVariablesOf(loaded)).toEqual([
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

  it("agboss describe: an unset one is labelled optional, a set one shows its value", () => {
    expect(describedEnvironment(loaded, { PORT: "9" }).fields).toEqual({
      region: "<unset REGION, optional>",
      port: "9",
      debug: "<unset DEBUG, optional>",
    });
  });
});
