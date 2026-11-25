/**
 * #1301b: `secret` / `previousSecret` of a `@PiiPolicy`, `piiSecret` / `previousPiiSecret` of the
 * `@DatabaseStorage`, key rotation (one value keeps its token, old tokens still reveal),
 * `[pii.secret-required]`, no key from `InMemoryDatabaseStorage`, the test key only through the test seam, the masked `Logger`.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { applicationPiiKeyOf } from "../../src/application/application-pii.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { createAppWithoutPiiKey } from "./without-pii-key.js";
import { Injectable } from "../../src/components/decorators.js";
import { Text } from "../../src/dto/index.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import {
  DatabaseStorage,
  InMemoryDatabaseStorage,
  PiiAction,
  PiiKind,
  PiiPolicy,
  SqliteDriver,
  secret,
  inline,
  Ttl,
} from "../../src/index.js";
import { Logger, LogLevel, type LogEntry } from "../../src/infrastructure/logger.js";
import { TEST_PREVIOUS_PSEUDONYM_KEY, TEST_PSEUDONYM_KEY } from "../../src/pii/application-key.js";
import { maskedLoggerOf } from "../../src/pii/masked-logger.js";
import { maskedText, type PiiFinding } from "../../src/pii/masking.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { piiRuntimeOf } from "../../src/pii/runtime.js";
import { tokenOf } from "../../src/pii/tokens.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { days } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { ContactPiiPolicy, OpenWorkflow, PII_KEY_VARIABLE, PiiWorkflow } from "./pii.fixture.js";
import { piiApp } from "./boundary.helpers.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const OLD = "old-pii-key";
const NEW = "new-pii-key";
const EMAIL = "alice@example.com";

const findingOf = (key: string, previousKey?: string): PiiFinding => ({
  start: 0,
  end: EMAIL.length,
  label: "email",
  kind: PiiKind.Email,
  action: PiiAction.tokenize(),
  policy: "p",
  key,
  ...(previousKey === undefined ? {} : { previousKey }),
  rank: 0,
});

describe("#1301b: key rotation keeps one value one token", () => {
  const oldToken = tokenOf("email", EMAIL, OLD, {});
  const newToken = tokenOf("email", EMAIL, NEW, {});

  it("the keys differ, so a rotation without previousSecret would give the value another token", () => {
    expect(oldToken).not.toBe(newToken);
  });

  it("a thread that holds the token made under the previous key keeps it", () => {
    const known = { [oldToken]: EMAIL };

    expect(tokenOf("email", EMAIL, NEW, known, OLD)).toBe(oldToken);
    expect(maskedText(EMAIL, [findingOf(NEW, OLD)], known).text).toBe(oldToken);
  });

  it("a thread without one mints under the new key", () => {
    expect(tokenOf("email", EMAIL, NEW, {}, OLD)).toBe(newToken);
    expect(tokenOf("email", EMAIL, NEW, { [oldToken]: "someone-else@example.com" }, OLD)).toBe(
      newToken,
    );
  });

  it("a token already made under the new key is kept too, and two values never share a token", () => {
    expect(tokenOf("email", EMAIL, NEW, { [newToken]: EMAIL }, OLD)).toBe(newToken);
    expect(tokenOf("email", "bob@example.com", NEW, { [oldToken]: EMAIL }, OLD)).not.toBe(oldToken);
  });

  it("the token still reveals: it is the thread's own map, no key is needed", async () => {
    const masked = maskedText(EMAIL, [findingOf(NEW, OLD)], { [oldToken]: EMAIL });
    const { revealedText } = await import("../../src/pii/tokens.js");

    expect(revealedText(`write to ${masked.text}`, { [oldToken]: EMAIL }).text).toBe(
      `write to ${EMAIL}`,
    );
  });

  it("without a previous key nothing changes", () => {
    expect(tokenOf("email", EMAIL, NEW, { [oldToken]: EMAIL })).toBe(newToken);
  });
});

describe("#1301b: a set rotating from a previous key hashes under both", () => {
  const policies = new PiiPolicySet([], NEW, [], NEW, { fieldKey: OLD, rootKey: OLD });
  const plain = new PiiPolicySet([], NEW);

  it("previousFingerprint is what the fingerprint was under the old keys; none when not rotating", () => {
    const before = new PiiPolicySet([], OLD);

    expect(policies.previousFingerprint).toBe(before.fingerprint);
    expect(policies.previousFingerprint).not.toBe(policies.fingerprint);
    expect(plain.previousFingerprint).toBeUndefined();
  });

  it("the redaction digest and the mask-cache key too", () => {
    const before = new PiiPolicySet([], OLD);

    expect(policies.previousRedactionDigestOf(["a"])).toBe(before.redactionDigestOf(["a"]));
    expect(policies.previousMaskCacheKeyOf("text", true)).toBe(before.maskCacheKeyOf("text", true));
    expect(plain.previousRedactionDigestOf(["a"])).toBeUndefined();
    expect(plain.previousMaskCacheKeyOf("text", false)).toBeUndefined();
  });

  it("an execution's own key replaces the tokens' key only: the roots stay", () => {
    const own = policies.withFieldKey("execution-key");

    expect(own.previous).toEqual({ rootKey: OLD, fieldKey: undefined });
    expect(own.previousFingerprint).toBeDefined();
  });
});

@PiiPolicy({
  name: "rotating-pii-policy",
  description: "Emails by token, rotating its own key",
  rules: [PiiKind.Email.tokenize()],
  secret: secret("PII_ROTATING_SECRET"),
  previousSecret: secret.optional("PII_ROTATING_PREVIOUS"),
})
class RotatingPiiPolicy {}

@PiiPolicy({
  name: "strict-rotating-pii-policy",
  description: "Emails by token, a required previous key",
  rules: [PiiKind.Email.tokenize()],
  secret: secret("PII_ROTATING_SECRET"),
  previousSecret: secret("PII_ROTATING_PREVIOUS"),
})
class StrictRotatingPiiPolicy {}

const runtimeOf = (cls: new () => object, env: NodeJS.ProcessEnv) => {
  const assembled = {
    byElement: new Map([["agent", [cls]]]),
    observability: [],
    model: [],
    excludes: { workflow: [], byElement: new Map() },
    chains: [],
    classes: [cls],
    detectors: [],
  };
  return piiRuntimeOf(assembled, {
    resolve: (type) => new (type as new () => object)(),
    processEnv: env,
    detectionOf: () => () => Promise.reject(new Error("no model")),
    contexts: { tenantContext: Object as never, executionContext: Object as never },
    fieldKey: "application-key",
  });
};

describe("#1301b: a policy's secret and previousSecret", () => {
  it("its own key makes the tokens; its previous key keeps the old ones", async () => {
    const set = runtimeOf(RotatingPiiPolicy, {
      PII_ROTATING_SECRET: NEW,
      PII_ROTATING_PREVIOUS: OLD,
    }).policiesOf("agent");
    const oldToken = tokenOf("email", EMAIL, OLD, {});

    const kept = await set.mask(
      EMAIL,
      { [oldToken]: EMAIL },
      (await import("../../src/pii/runtime-policy.js")).DetectionMode.WithoutModel,
    );
    const fresh = await set.mask(
      EMAIL,
      {},
      (await import("../../src/pii/runtime-policy.js")).DetectionMode.WithoutModel,
    );

    expect(kept.masked.text).toBe(oldToken);
    expect(fresh.masked.text).toBe(tokenOf("email", EMAIL, NEW, {}));
  });

  it("secret.optional previous key unset: no rotation, no failure", () => {
    expect(() => runtimeOf(RotatingPiiPolicy, { PII_ROTATING_SECRET: NEW })).not.toThrow();
  });

  it("a required previous key unset, or the secret unset: the start fails naming the variable, never a value", () => {
    expect(() => runtimeOf(StrictRotatingPiiPolicy, { PII_ROTATING_SECRET: NEW })).toThrow(
      "PII_ROTATING_PREVIOUS is not set (strict-rotating-pii-policy.previousSecret)",
    );
    expect(() => runtimeOf(RotatingPiiPolicy, { PII_ROTATING_PREVIOUS: OLD })).toThrow(
      "PII_ROTATING_SECRET is not set (rotating-pii-policy.secret)",
    );
    expect(() => runtimeOf(RotatingPiiPolicy, { PII_ROTATING_SECRET: "" })).toThrow(
      "PII_ROTATING_SECRET is not set",
    );
  });

  it("the error never carries a key", () => {
    try {
      runtimeOf(StrictRotatingPiiPolicy, { PII_ROTATING_SECRET: "super-secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-value");
    }
  });
});

class TokenFieldDto {
  @Text({ prompt: "who", sensitive: PiiAction.tokenize() })
  who!: string;
}

@PiiPolicy({
  name: "ssn-token-pii-policy",
  description: "SSNs by token with the application key",
  rules: [PiiKind.UsSsn.tokenize()],
})
class SsnTokenPiiPolicy {}

@DatabaseStorage({
  driver: SqliteDriver({ path: ":memory:" }),
  auditLogTtl: days(1),
  ledgerEntriesTtl: days(1),
  piiSecret: secret("PII_STORAGE_SECRET"),
  previousPiiSecret: secret.optional("PII_STORAGE_PREVIOUS"),
})
class KeyedStorage {}

@DatabaseStorage({
  driver: SqliteDriver({ path: ":memory:" }),
  auditLogTtl: days(1),
  ledgerEntriesTtl: days(1),
})
class KeylessStorage {}

const applicationWith = async (
  options: {
    storage?: unknown;
    piiPolicies?: readonly (new () => object)[];
    workflow?: new () => object;
  },
  name: string,
) => {
  @Application({
    name,
    modelProvider: TestModelProvider,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [options.workflow ?? OpenWorkflow],
    budgets: TEST_BUDGETS,
    piiPolicies: [ContactPiiPolicy, ...(options.piiPolicies ?? [])],
    ...(options.storage === undefined ? {} : { storage: options.storage as never }),
  })
  class DynamicApplication {}
  return applicationOf(DynamicApplication);
};

describe("#1301b: the application's key from the storage", () => {
  it("piiSecret's variable is the key, previousPiiSecret's the one it rotates from", async () => {
    const assembled = await applicationWith({ storage: KeyedStorage }, "keyed-storage-application");
    const keys = applicationPiiKeyOf(assembled, {
      environment: {} as never,
      env: { PII_STORAGE_SECRET: NEW, PII_STORAGE_PREVIOUS: OLD },
    });

    expect(keys).toEqual({ key: NEW, isInstanceKey: false, previousKey: OLD });
  });

  it("an optional previous key unset: no previous key; a required piiSecret unset fails naming the variable", async () => {
    const assembled = await applicationWith({ storage: KeyedStorage }, "keyed-storage-application");
    const env = { PII_STORAGE_SECRET: NEW };

    expect(applicationPiiKeyOf(assembled, { environment: {} as never, env })).toEqual({
      key: NEW,
      isInstanceKey: false,
    });
    expect(() => applicationPiiKeyOf(assembled, { environment: {} as never, env: {} })).toThrow(
      "@DatabaseStorage({ piiSecret }) has no value — PII_STORAGE_SECRET is not set",
    );
  });

  it("under a test's fallback the unset variables get the test's two keys", async () => {
    const assembled = await applicationWith({ storage: KeyedStorage }, "keyed-storage-application");

    expect(
      applicationPiiKeyOf(assembled, {
        environment: {} as never,
        env: {},
        fallback: TEST_PSEUDONYM_KEY,
      }),
    ).toEqual({
      key: TEST_PSEUDONYM_KEY,
      isInstanceKey: false,
      previousKey: TEST_PREVIOUS_PSEUDONYM_KEY,
    });
  });
});

describe("#1301b: [pii.secret-required]", () => {
  const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };

  const failureOf = async (application: new () => object): Promise<ConfigError.GraphRules> => {
    const failure = await createAppWithoutPiiKey(application as never, offline).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError.GraphRules);
    return failure as ConfigError.GraphRules;
  };

  it("a real storage without piiSecret and a tokenize() policy: the start fails, naming the policy", async () => {
    @Application({
      name: "keyless-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [PiiWorkflow],
      piiPolicies: [SsnTokenPiiPolicy],
      budgets: TEST_BUDGETS,
      storage: KeylessStorage,
    })
    class KeylessApplication {}

    const error = await failureOf(KeylessApplication);

    expect(error.violations.map((item) => item.code)).toEqual(["pii.secret-required"]);
    expect(error.violations[0]?.message).toContain("policy ssn-token-pii-policy");
    expect(error.violations[0]?.message).toContain("@DatabaseStorage({ …, piiSecret:");
  });

  it("a policy with a secret of its own needs none", async () => {
    @Application({
      name: "own-secret-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [OpenWorkflow],
      piiPolicies: [ContactPiiPolicy],
      budgets: TEST_BUDGETS,
    })
    class OwnSecretApplication {}
    const processEnv = { [PII_KEY_VARIABLE]: "k" };

    const app = await createTestAppWith(OwnSecretApplication, { ...offline, processEnv }).catch(
      (error: unknown) => error,
    );

    expect(app).not.toBeInstanceOf(ConfigError.GraphRules);
  });

  it("InMemoryDatabaseStorage supplies no key: a non-test app that tokenizes fails the start", async () => {
    const assembled = await applicationWith(
      { storage: InMemoryDatabaseStorage, piiPolicies: [SsnTokenPiiPolicy] },
      "in-memory-application",
    );

    expect(() => applicationPiiKeyOf(assembled, { environment: {} as never, env: {} })).toThrow(
      ConfigError.GraphRules,
    );
  });

  it("testWith's fixed key is used only through the test seam, never under NODE_ENV=production", async () => {
    const assembled = await applicationWith(
      { storage: InMemoryDatabaseStorage, piiPolicies: [SsnTokenPiiPolicy] },
      "in-memory-application",
    );
    const source = { environment: {} as never, fallback: TEST_PSEUDONYM_KEY };

    expect(applicationPiiKeyOf(assembled, { ...source, env: {} })).toEqual({
      key: TEST_PSEUDONYM_KEY,
      isInstanceKey: false,
    });
    expect(() =>
      applicationPiiKeyOf(assembled, { ...source, env: { NODE_ENV: "production" } }),
    ).toThrow(ConfigError.GraphRules);
  });

  it("the storage's piiSecret is not rescued by the test key in production either", async () => {
    const assembled = await applicationWith({ storage: KeyedStorage }, "keyed-storage-application");

    expect(() =>
      applicationPiiKeyOf(assembled, {
        environment: {} as never,
        env: { NODE_ENV: "production" },
        fallback: TEST_PSEUDONYM_KEY,
      }),
    ).toThrow("PII_STORAGE_SECRET is not set");
  });

  it("nothing tokenizes and no key is named: a key of the instance, the start goes on", async () => {
    const assembled = await applicationWith(
      { storage: KeylessStorage },
      "masking-only-application",
    );
    const keys = applicationPiiKeyOf(assembled, { environment: {} as never, env: {} });

    expect(keys.isInstanceKey).toBe(true);
  });

  it("a sensitive tokenize() DTO field fails the start the same way, naming Dto.field", async () => {
    const { Workflow, WorkflowFinish, WorkflowStart, Agent } = await import("../../src/index.js");
    const { WorkflowFinishTextDto } = await import("../../src/dto/index.js");
    const { onStart } = await import("../helpers/flow.js");

    @WorkflowStart({ name: "token-field-workflow-start", description: "s", input: TokenFieldDto })
    class TokenFieldStart {}
    @Agent({
      name: "token-field-agent",
      description: "a",
      prompt: inline("p"),
      model: "test/m",
      input: { who: TokenFieldDto },
    })
    class TokenFieldAgent {}
    @WorkflowFinish({
      name: "token-field-workflow-finish",
      description: "f",
      output: WorkflowFinishTextDto,
    })
    class TokenFieldFinish {}
    @Workflow({
      name: "token-field-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(TokenFieldStart).toAgent(TokenFieldAgent).toFinish(TokenFieldFinish)],
      defaults: { models: { temperature: 0 } },
    })
    class TokenFieldWorkflow {}
    @Application({
      name: "token-field-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [TokenFieldWorkflow],
      budgets: TEST_BUDGETS,
      storage: KeylessStorage,
    })
    class TokenFieldApplication {}

    const error = await failureOf(TokenFieldApplication);

    expect(error.violations[0]?.code).toBe("pii.secret-required");
    expect(error.violations[0]?.message).toContain("field TokenFieldDto.who");
  });
});

describe("#1301b: a Logger the application's components inject is masked", () => {
  afterEach(resetLogged);

  it("maskedLoggerOf: the message goes through the mask, every other thing is the logger's own", () => {
    const entries: LogEntry[] = [];
    class Plain extends Logger {
      readonly note = "mine";
      write(entry: LogEntry): void {
        entries.push(entry);
      }
      count(): number {
        return entries.length;
      }
    }
    const logger = new Plain();
    const masked = maskedLoggerOf(logger, (message) => message.replaceAll(EMAIL, "<email>"));

    masked.write({ level: LogLevel.Warn, code: "x.y", message: `to ${EMAIL}`, time: new Date(0) });

    expect(entries).toEqual([
      { level: LogLevel.Warn, code: "x.y", message: "to <email>", time: new Date(0) },
    ]);
    expect(masked).toBeInstanceOf(Plain);
    expect((masked as Plain).note).toBe("mine");
    expect((masked as Plain).count()).toBe(1);
  });

  it("a service that injects Logger writes a masked line when the application lists PII policies", async () => {
    @Injectable({ deps: [Logger] })
    class Talker {
      constructor(readonly log: Logger) {}
    }
    @Application({
      name: "logger-masking-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [OpenWorkflow],
      piiPolicies: [ContactPiiPolicy],
      providers: [RecordingLogger, Talker],
      budgets: TEST_BUDGETS,
      storage: InMemoryDatabaseStorage,
    })
    class LoggerMaskingApplication {}
    const app = await createTestAppWith(LoggerMaskingApplication, {
      processEnv: { [PII_KEY_VARIABLE]: "k" },
      gateway: createScriptedGateway(new ScriptBook()),
    });

    app.resolve(Talker).log.write({
      level: LogLevel.Warn,
      code: "talker.said",
      message: `wrote to ${EMAIL}`,
      time: new Date(),
    });
    await app.close();

    const said = logged.find((entry) => entry.code === "talker.said");
    expect(said?.message).not.toContain(EMAIL);
    expect(said?.message).toContain("<email");
  });
});

describe("#1301b: removed names are gone", () => {
  it("pseudonymKey and detectWithModel are no options any more", () => {
    // @ts-expect-error pseudonymKey is secret
    PiiPolicy({ rules: [PiiKind.Email.mask()], pseudonymKey: secret("A") });
    // @ts-expect-error detectWithModel is model
    PiiPolicy({ rules: [PiiKind.Email.mask()], detectWithModel: "a/b" });
    expect(piiApp).toBeDefined();
  });
});
