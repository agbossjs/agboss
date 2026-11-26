/**
 * #1324b, #266 (review 1422 M1): `agboss check` and `describe` need no variable and no key —
 * `resolveEnv(…, { secrets: "deferred" })` gives a placeholder for an unset required value and keeps
 * an unset secret unresolved; a set variable still wins and a wrong one still fails.
 */
import { describe, expect, it } from "vitest";
import { defineEnv, resolveEnv } from "../../src/environments/define-env.js";
import { Secret } from "../../src/environments/secret.js";
import { env, secret } from "../../src/index.js";

const contract = defineEnv({
  url: env("DEFERRED_URL"),
  port: env.integer("DEFERRED_PORT"),
  debug: env.boolean("DEFERRED_DEBUG"),
  region: env("DEFERRED_REGION", { default: "eu" }),
  key: secret("DEFERRED_KEY"),
  ratio: env.number("DEFERRED_RATIO"),
  deadline: env.duration("DEFERRED_DEADLINE"),
  history: env.ttl("DEFERRED_TTL"),
  limit: env.bytes("DEFERRED_BYTES"),
  budget: env.usd("DEFERRED_USD"),
});

describe("deferred resolution (check, describe)", () => {
  it("an unset required value is a placeholder, a default stays, a secret stays unresolved", () => {
    const values = resolveEnv(contract, {}, undefined, { secrets: "deferred" });

    expect(values.url).toBe("");
    expect(values.port).toBe(0);
    expect(values.debug).toBe(false);
    expect(values.region).toBe("eu");
    // the secret stays unresolved: revealing it is the missing variable, never a placeholder
    expect(values.key).toBeInstanceOf(Secret);
    expect(() => (values.key as Secret).reveal()).toThrow(/DEFERRED_KEY/);
  });

  it("a typed reader gets a number of its own type, never undefined", () => {
    const values = resolveEnv(contract, {}, undefined, { secrets: "deferred" });

    for (const key of ["ratio", "deadline", "history", "limit", "budget"] as const)
      expect(typeof values[key], key).toBe("number");
  });

  it("a set variable wins over the placeholder; a value that does not parse still fails", () => {
    const values = resolveEnv(contract, { DEFERRED_URL: "https://x.example" }, undefined, {
      secrets: "deferred",
    });

    expect(values.url).toBe("https://x.example");
    expect(() =>
      resolveEnv(contract, { DEFERRED_PORT: "abc" }, undefined, { secrets: "deferred" }),
    ).toThrow(/environment\.invalid-value/);
  });

  it("the default mode still fails on the unset ones, naming variables only", () => {
    expect(() => resolveEnv(contract, { DEFERRED_KEY: "s3cret-value" })).toThrow(
      /environment\.missing-variable\] DEFERRED_URL is not set/,
    );
    try {
      resolveEnv(contract, { DEFERRED_KEY: "s3cret-value" });
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret-value");
    }
  });
});
