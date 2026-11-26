/**
 * #1324b: a `configureEnv` value — from a profile or from a test's `env` — reaches every reference
 * the application's options name, a storage driver's file included, never the variable's default
 * behind its back; a secret comes from the process (or a test's own `env`), never from a profile.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAppWith } from "../../src/application/create-app.js";
import { configureEnv } from "../../src/index.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { execute } from "../helpers/flow.js";
import { BookOrderStart } from "../app/fixtures/rotation/rotation.application.js";
import { OverrideApplication } from "./fixtures/override.application.js";
import { DEFAULT_DATABASE, overrideEnv, PROFILE_DATABASE } from "./fixtures/override-env.js";

const folder = mkdtempSync(join(tmpdir(), "agboss-override-"));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const book = async (app: Awaited<ReturnType<typeof createAppWith>>): Promise<void> => {
  try {
    await execute(app, BookOrderStart, { orderId: "42", amountUsd: 10 });
  } finally {
    await app.close();
  }
};

describe("#1324b: an override reaches the storage's options", () => {
  it("testWith({ env }): the file the override names is opened, the variable's default is not", async () => {
    const file = join(folder, "from-test-env.sqlite");

    await book(
      await createTestAppWith(OverrideApplication, {
        processEnv: { OVERRIDE_IDEMPOTENCY: "process-secret" },
        envOverrides: [configureEnv(overrideEnv, { databasePath: file })],
      }),
    );

    expect(existsSync(file)).toBe(true);
    expect(existsSync(DEFAULT_DATABASE)).toBe(false);
  });

  it("a profile's configureEnv: the storage opens the profile's file", async () => {
    const file = PROFILE_DATABASE;

    await book(
      await createAppWith(OverrideApplication, {
        profile: "prod",
        processEnv: { OVERRIDE_IDEMPOTENCY: "process-secret" },
        handleSignals: false,
      }),
    );

    expect(existsSync(file)).toBe(true);
    expect(existsSync(DEFAULT_DATABASE)).toBe(false);
  });

  it("a secret is no override: a test's env that sets one is refused, its value never printed", async () => {
    const failure = await createTestAppWith(OverrideApplication, {
      processEnv: {},
      envOverrides: [
        configureEnv(overrideEnv, {
          databasePath: join(folder, "x.sqlite"),
          idempotency: "test-own-key" as never,
        }),
      ],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toMatch(
      /\[environment\.invalid-value\] configureEnv sets idempotency, a secret/,
    );
    expect((failure as Error).message).not.toContain("test-own-key");
  });
});

describe("#1324b: a secret comes from the process, never from a profile", () => {
  it("a profile that sets one is refused at its load, the value never printed", async () => {
    const failure = await createAppWith(OverrideApplication, {
      profile: "leaky",
      processEnv: { OVERRIDE_IDEMPOTENCY: "process-secret" },
      handleSignals: false,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toMatch(/idempotency, a secret/);
    expect((failure as Error).message).not.toContain("from-a-profile");
  });
});
