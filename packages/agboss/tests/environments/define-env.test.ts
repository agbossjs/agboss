/**
 * #1324b: `defineEnv` is the one reader of the process's variables — a method-free dictionary of the
 * `env.*` and `secret(…)` references it was given, that resolves them when the application starts (every
 * problem at once, naming variables and never values) and is a dependency token (`deps: [appEnv]`).
 */
import { describe, expect, it } from "vitest";
import { createContainer } from "../../src/components/container/container.js";
import { Injectable } from "../../src/components/decorators.js";
import {
  bearer,
  configureEnv,
  defineEnv,
  isEnvContract,
  resolveEnv,
} from "../../src/environments/define-env.js";
import { env } from "../../src/environments/env-readers.js";
import { EnvironmentError, EnvironmentErrorCode } from "../../src/environments/errors.js";
import { Secret, secret } from "../../src/environments/secret.js";
import { ConfigError } from "../../src/index.js";
import { Ttl, kilobytes, megabytes, usd } from "../../src/units/index.js";

const appEnv = defineEnv({
  region: env("REGION"),
  port: env.integer("PORT", { default: 8080 }),
  ratio: env.number("RATIO"),
  debug: env.boolean("DEBUG", { default: false }),
  deadline: env.duration("DEADLINE"),
  history: env.ttl("HISTORY_TTL"),
  audit: env.ttl("AUDIT_TTL", { allowNone: true }),
  maxFile: env.bytes("MAX_FILE"),
  budget: env.usd("DAILY_BUDGET"),
  apiKey: secret("API_KEY"),
  token: secret.optional("TOKEN"),
  nickname: env.optional("NICKNAME"),
});

const GOOD = {
  REGION: "eu",
  RATIO: "0.25",
  DEADLINE: "30d",
  HISTORY_TTL: "forever",
  AUDIT_TTL: "none",
  MAX_FILE: "64kb",
  DAILY_BUDGET: "40",
  API_KEY: "sk-live-1",
  DEBUG: "1",
};

describe("#1324b: defineEnv is a method-free dictionary of references", () => {
  it("has no prototype, no method, is frozen, and holds the references it was given", () => {
    expect(Reflect.getPrototypeOf(appEnv)).toBeNull();
    expect(Object.isFrozen(appEnv)).toBe(true);
    expect(Object.keys(appEnv)).toHaveLength(12);
    expect(Object.values(appEnv).every((value) => typeof value !== "function")).toBe(true);
    expect(appEnv.apiKey).toBeInstanceOf(Secret);
    expect(isEnvContract(appEnv)).toBe(true);
    expect(isEnvContract({})).toBe(false);
  });

  it.each(["then", "__proto__", "constructor", "prototype"])(
    "refuses the reserved key %s at definition",
    (key) => {
      const spec = JSON.parse(`{ "${key}": null }`) as object;
      Object.defineProperty(spec, key, { value: env("X"), enumerable: true });

      expect(() => defineEnv(spec as never)).toThrow(ConfigError.Environment);
    },
  );

  it("refuses a value that is no reference", () => {
    expect(() => defineEnv({ port: 8080 } as never)).toThrow(ConfigError.Environment);
  });
});

describe("#1324b: resolveEnv reads the process once, typed", () => {
  it("resolves every reader to its type and a secret to a Secret read with .reveal()", () => {
    const values = resolveEnv(appEnv, GOOD);

    expect(values).toMatchObject({
      region: "eu",
      port: 8080,
      ratio: 0.25,
      debug: true,
      deadline: 30 * 86_400_000,
      history: Ttl.Forever,
      audit: Ttl.None,
      maxFile: kilobytes(64),
      budget: usd(40),
      token: undefined,
      nickname: undefined,
    });
    expect(values.apiKey.reveal()).toBe("sk-live-1");
    expect(String(values.apiKey)).toBe("***");
    expect(Object.isFrozen(values)).toBe(true);
  });

  it("reads durations, bytes and ttls in their units", () => {
    const read = (spec: object, processEnv: NodeJS.ProcessEnv) =>
      resolveEnv(defineEnv(spec as never), processEnv) as Record<string, unknown>;

    expect(read({ a: env.duration("A") }, { A: "24h" }).a).toBe(86_400_000);
    expect(read({ a: env.duration("A") }, { A: "500ms" }).a).toBe(500);
    expect(read({ a: env.ttl("A") }, { A: "7d" }).a).toBe(7 * 86_400_000);
    expect(read({ a: env.bytes("A") }, { A: "10mb" }).a).toBe(megabytes(10));
    expect(read({ a: env.bytes("A") }, { A: "512b" }).a).toBe(512);
    expect(read({ a: env.optional("A") }, { A: "x" }).a).toBe("x");
  });

  it("names every missing variable at once, never a value", () => {
    const error = catching(() => resolveEnv(appEnv, {}));

    expect(error).toBeInstanceOf(EnvironmentError);
    expect(error.code).toBe(EnvironmentErrorCode.MissingVariables);
    for (const variable of ["REGION", "RATIO", "DEADLINE", "HISTORY_TTL", "API_KEY"])
      expect(error.message).toContain(variable);
    expect(error.message).not.toContain("TOKEN");
  });

  it("names a variable that does not parse and what it was to be, never its value", () => {
    const error = catching(() =>
      resolveEnv(appEnv, { ...GOOD, DEADLINE: "soon-4242", AUDIT_TTL: "never", PORT: "80x" }),
    );

    expect(error.code).toBe(EnvironmentErrorCode.InvalidValue);
    expect(error.message).toContain("DEADLINE is not a duration");
    expect(error.message).toContain("AUDIT_TTL is not a duration");
    expect(error.message).toContain("PORT is not an integer");
    expect(error.message).not.toContain("4242");
  });

  it("`none` is no ttl unless the field allows it", () => {
    const error = catching(() => resolveEnv(appEnv, { ...GOOD, HISTORY_TTL: "none" }));

    expect(error.message).toContain("HISTORY_TTL is not a duration (30d, 24h), forever");
  });

  it("an empty variable is unset", () => {
    expect(catching(() => resolveEnv(appEnv, { ...GOOD, REGION: "" })).message).toContain("REGION");
  });
});

describe("#1324b: configureEnv, bearer and the dependency token", () => {
  it("overrides take the place of the process's for their keys only, and a text for a secret is a Secret", () => {
    const values = resolveEnv(
      appEnv,
      { ...GOOD, REGION: "eu" },
      configureEnv(appEnv, { region: "us", port: 9000 }),
    );

    expect(values.region).toBe("us");
    expect(values.port).toBe(9000);
    expect(values.deadline).toBe(30 * 86_400_000);
    const secretValues = resolveEnv(appEnv, GOOD, {
      contract: appEnv,
      values: { apiKey: "from-override" },
    });
    expect(secretValues.apiKey.reveal()).toBe("from-override");
  });

  it("bearer(secretRef) names the secret for an Authorization header", () => {
    expect(bearer(appEnv.apiKey)).toEqual({ kind: "bearer", secret: appEnv.apiKey });
  });

  it("`deps: [appEnv]` injects the resolved values, once per container", () => {
    const tokenEnv = defineEnv({ region: env("REGION"), key: secret("API_KEY") });
    const seen: unknown[] = [];

    @Injectable({ deps: [tokenEnv] })
    class RegionService {
      constructor(readonly config: { readonly region: string; readonly key: Secret }) {
        seen.push(config);
      }
    }
    const container = createContainer(
      { modules: [{ owner: "x-workflow", providers: [RegionService] }], core: new Map() },
      { envOf: (contract) => resolveEnv(contract, { REGION: "eu", API_KEY: "k1" }) },
    );
    const service = container.get(RegionService) as RegionService;

    expect(service.config.region).toBe("eu");
    expect(service.config.key.reveal()).toBe("k1");
    expect(container.get(tokenEnv)).toBe(service.config);
    expect(seen).toHaveLength(1);
  });

  it("without an envOf the container reads this process's variables", () => {
    const processEnv = defineEnv({ home: env("AGBOSS_TEST_ENV_1324B") });
    process.env.AGBOSS_TEST_ENV_1324B = "yes";
    try {
      expect(createContainer({ modules: [], core: new Map() }).get(processEnv)).toEqual({
        home: "yes",
      });
    } finally {
      delete process.env.AGBOSS_TEST_ENV_1324B;
    }
  });
});

function catching(call: () => unknown): EnvironmentError {
  try {
    call();
  } catch (error) {
    if (error instanceof EnvironmentError) return error;
    throw error;
  }
  throw new Error("expected an EnvironmentError");
}
