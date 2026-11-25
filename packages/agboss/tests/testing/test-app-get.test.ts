/** #1328b: `app.get(token)` gives a class's instance and a `defineEnv` dictionary's values. */
import { afterEach, describe, expect, expectTypeOf, vi } from "vitest";
import { defineEnv } from "../../src/environments/define-env.js";
import { env } from "../../src/environments/env-readers.js";
import { testWith } from "../../src/testing/index.js";
import {
  RemoteDeskApplication,
  SingleTenantAuthenticator,
} from "../a2a/fixtures/remote.workflow.js";

const test = testWith(RemoteDeskApplication);
const deskEnv = defineEnv({ region: env("C18_TEST_REGION") });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#1328b: TestApp.get", () => {
  test("a class gives the instance the app uses", async ({ app }) => {
    await app.ready();

    expect(app.get(SingleTenantAuthenticator)).toBe(app.get(SingleTenantAuthenticator));
    expectTypeOf(app.get(SingleTenantAuthenticator)).toEqualTypeOf<SingleTenantAuthenticator>();
  });

  test("a defineEnv dictionary gives its resolved values", async ({ app }) => {
    vi.stubEnv("C18_TEST_REGION", "eu");
    await app.ready();

    expect(app.get(deskEnv).region).toBe("eu");
    expectTypeOf(app.get(deskEnv).region).toEqualTypeOf<string>();
  });

  test("before the app is built it fails with test.app-not-ready", ({ app }) => {
    expect(() => app.get(SingleTenantAuthenticator)).toThrow(/not built yet/u);
  });
});
