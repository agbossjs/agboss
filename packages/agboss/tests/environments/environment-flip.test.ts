/**
 * #1324b (the environment flip): the application's secrets resolve through `defineEnv` / `SecretRef`
 * only. A missing secret fails the start closed — `[environment.missing-variable]`, naming the
 * variable — and no secret value appears in `agboss describe`'s output, in an error, in the log or in
 * an `ErrorRecord`. A test sets variables with `configureEnv`, the application context holds no
 * environment, and the application is selected by profile.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { createAppWith } from "../../src/application/create-app.js";
import { Injectable } from "../../src/components/decorators.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { errorRecordOf } from "../../src/core/error-record.js";
import { describeApplication, describeApplicationData } from "../../src/describe/index.js";
import { defineEnv, resolveEnv } from "../../src/environments/define-env.js";
import {
  ApplicationContext,
  configureEnv,
  DatabaseStorage,
  env,
  secret,
  SqliteDriver,
  type InferEnv,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { BookOrderWorkflow } from "../app/fixtures/rotation/rotation.application.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";

const IDEMPOTENCY = "flip-idempotency-VALUE-1";
const PREVIOUS = "flip-previous-VALUE-2";
const PII = "flip-pii-VALUE-3";
const API_KEY = "flip-api-key-VALUE-4";
const SECRETS = [IDEMPOTENCY, PREVIOUS, PII, API_KEY];

const appEnv = defineEnv({
  apiUrl: env("FLIP_API_URL", { default: "https://api.example.com" }),
  apiKey: secret("FLIP_API_KEY"),
});

@Injectable({ deps: [appEnv, ApplicationContext] })
class ApiService {
  constructor(
    readonly config: InferEnv<typeof appEnv>,
    readonly context: ApplicationContext,
  ) {}
}

@DatabaseStorage({
  name: "flip-storage",
  driver: SqliteDriver.inMemory(),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
  idempotencySecret: secret("FLIP_IDEMPOTENCY"),
  previousIdempotencySecret: secret("FLIP_PREVIOUS"),
  piiSecret: secret("FLIP_PII"),
})
class FlipStorage {}

@Application({
  name: "flip-application",
  version: "1.0.0",
  workflows: [BookOrderWorkflow],
  storage: FlipStorage,
  budgets: TEST_BUDGETS,
  providers: [ApiService, RecordingLogger],
})
class FlipApplication {}

const PROCESS = {
  FLIP_IDEMPOTENCY: IDEMPOTENCY,
  FLIP_PREVIOUS: PREVIOUS,
  FLIP_PII: PII,
  FLIP_API_KEY: API_KEY,
};

const leaksOf = (text: string): string[] => SECRETS.filter((value) => text.includes(value));

afterEach(() => {
  resetLogged();
});

describe("#1324b: a missing secret fails the start closed", () => {
  it.each(["FLIP_IDEMPOTENCY", "FLIP_PII"])(
    "%s unset: [environment.missing-variable] naming it, and no value of the others",
    async (missing) => {
      const processEnv = Object.fromEntries(
        Object.entries(PROCESS).filter(([name]) => name !== missing),
      );

      const failure = await createAppWith(FlipApplication, { processEnv }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ConfigError.Environment);
      const { message } = failure as ConfigError.Environment;
      expect(message).toMatch(
        new RegExp(`^\\[environment\\.missing-variable\\] .*${missing} is not set`, "u"),
      );
      expect(leaksOf(message)).toEqual([]);
      expect(leaksOf(JSON.stringify(errorRecordOf(failure)))).toEqual([]);
    },
  );

  it("an empty variable is unset too", async () => {
    const failure = await createAppWith(FlipApplication, {
      processEnv: { ...PROCESS, FLIP_PII: "" },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ConfigError.Environment);
  });
});

describe("#1324b: no secret value in what is shown", () => {
  it("agboss describe: the text and the data name the storage, never a key", async () => {
    const text = (await describeApplication(FlipApplication, { processEnv: PROCESS })).join("\n");
    const data = JSON.stringify(
      await describeApplicationData(FlipApplication, { processEnv: PROCESS }),
    );

    expect(text).toContain("flip-storage");
    expect(leaksOf(text)).toEqual([]);
    expect(leaksOf(data)).toEqual([]);
  });

  it("the start log, the framework's log and an ErrorRecord of a failed resolve hold none", async () => {
    const app = await createAppWith(FlipApplication, { processEnv: PROCESS, handleSignals: false });
    try {
      expect(leaksOf(JSON.stringify(logged))).toEqual([]);
      expect(leaksOf(JSON.stringify(app.warnings))).toEqual([]);
    } finally {
      await app.close();
    }
    const failure = (() => {
      try {
        resolveEnv(appEnv, { FLIP_API_URL: "not-used", OTHER: API_KEY });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    const record = JSON.stringify(errorRecordOf(failure));

    expect(record).toContain("[environment.missing-variable]");
    expect(leaksOf(record)).toEqual([]);
  });

  it("a resolved secret prints as *** wherever it is shown", () => {
    const values = resolveEnv(appEnv, PROCESS);

    expect(leaksOf(JSON.stringify(values))).toEqual([]);
    expect(leaksOf(`${String(values.apiKey)} ${JSON.stringify({ k: values.apiKey })}`)).toEqual([]);
    expect(values.apiKey.reveal()).toBe(API_KEY);
  });
});

describe("#1324b: the profile selects, defineEnv holds the variables", () => {
  // testWith reads the test process's variables
  beforeAll(() => {
    for (const [name, value] of Object.entries(PROCESS)) vi.stubEnv(name, value);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const test = testWith(FlipApplication, {
    env: configureEnv(appEnv, { apiUrl: "https://api.test.example.com" }),
  });

  test("testWith({ env: configureEnv(…) }): a component reads it with deps: [appEnv], testApp.get(appEnv) shows it", async ({
    app,
  }) => {
    await app.ready();

    expect(app.get(ApiService).config.apiUrl).toBe("https://api.test.example.com");
    expect(app.get(appEnv).apiUrl).toBe("https://api.test.example.com");
  });

  test("the application context has name, version and profiles — no environment, no env", async ({
    app,
  }) => {
    await app.ready();
    const { context } = app.get(ApiService);

    expect(context.profiles).toEqual(["test"]);
    expect(context.name).toBe("flip-application");
    for (const gone of ["environment", "environmentName", "env"])
      expect(context).not.toHaveProperty(gone);
  });
});
