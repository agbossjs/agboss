/**
 * #825 AC6, AC7, #1317 — the application's key fields and the storage's idempotency key.
 * `piiKeyField` names a `Secret` field of the environment contract (a typo or a text field does not
 * compile; a field the contract lacks is `[environment.missing-field]` for a JavaScript caller); it
 * is no other key — a model provider's `apiKey` (the built-ins' `openRouterApiKey` when none is
 * listed), a `Secret` a listed class reads (`[application.pii-key-shared]`).
 * The idempotency key is the database storage's `idempotencySecret` (`[storage.secret-shared]` when
 * it shares a variable): an application with a database storage whose components can write under
 * a business key names it (`[application.idempotency-key-required]`).
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import {
  applicationIdempotencyKeysOf,
  TEST_IDEMPOTENCY_KEYS,
} from "../../src/application/idempotency-key.js";
import { createAppWith } from "../../src/application/create-app.js";
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { Application } from "../../src/application/application.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import type { Secret } from "../../src/index.js";
import {
  BookOrderWorkflow,
  ChargeOrderWorkflow,
} from "../app/fixtures/rotation/rotation.application.js";
import {
  Injectable,
  InjectionToken,
  provide,
  DatabaseStorage,
  Idempotency,
  OutboundCallRepository,
  SqliteDriver,
  secret,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Ttl,
} from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { onStart } from "../helpers/flow.js";
import { hours } from "../../src/units/index.js";
import type { ApplicationOptions } from "../../src/application/application.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

/** A workflow none of whose components can write under a business key. */
@WorkflowStart({
  name: "plain-workflow-start",
  description: "A text",
  input: WorkflowStartTextDto,
})
class PlainStart {}
@WorkflowFinish({
  name: "plain-workflow-finish",
  description: "It",
  output: WorkflowStartTextDto,
})
class PlainFinish {}
@Workflow({
  name: "plain-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(PlainStart).toFinish(PlainFinish)],
})
class PlainWorkflow {}

/** The contract of these applications: Secret fields, and one text field. */
class KeysEnvironment {
  openRouterApiKey?: Secret;
  piiKeyOne?: Secret;
  meshSigningKey?: Secret;
  label?: string;
}

/** A database storage on a temporary SQLite file; `keyed` names its idempotency secret. */
const storageOf = (name: string, keyed: boolean) => {
  @DatabaseStorage({
    name,
    driver: SqliteDriver.inMemory(),
    auditLogTtl: hours(24),
    ledgerEntriesTtl: hours(24),
    ...(keyed ? { idempotencySecret: secret("KEYS_TEST_IDEMPOTENCY") } : {}),
  })
  class KeysStorage {}
  return KeysStorage;
};

const KEYED = storageOf("keyed-keys-storage", true);
const UNKEYED = storageOf("unkeyed-keys-storage", false);

/** `[code] message` of each rule an application of `options` breaks; `[]` when it assembles. */
async function violationsOf(options: Partial<ApplicationOptions>): Promise<readonly string[]> {
  @Application({
    name: "keys-application",
    version: "1.0.0",
    environment: KeysEnvironment,
    workflows: [BookOrderWorkflow],
    storage: KEYED,
    budgets: TEST_BUDGETS,
    ...options,
  })
  class KeysApplication {}
  try {
    await applicationOf(KeysApplication);
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

const codesOf = async (options: Partial<ApplicationOptions>): Promise<readonly string[]> =>
  (await violationsOf(options)).map((line) => /^\[([^\]]+)\]/u.exec(line)?.[1] ?? line);

describe("#825 AC7: an idempotency key where business keys can be made", () => {
  it("a component that reaches Idempotency, a database storage with no idempotencySecret: refused, naming both", async () => {
    expect(await violationsOf({ storage: UNKEYED })).toEqual([
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] BookOrderAction reaches Idempotency, so it can write under a business key/u,
      ),
    ]);
  });

  it("one that sends a call through it too", async () => {
    expect(await violationsOf({ storage: UNKEYED, workflows: [ChargeOrderWorkflow] })).toEqual([
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] ChargeOrderAction reaches Idempotency/u,
      ),
    ]);
  });

  it("an application whose components reach neither needs none", async () => {
    @Application({
      name: "plain-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [PlainWorkflow],
      budgets: TEST_BUDGETS,
      storage: UNKEYED,
    })
    class PlainApplication {}

    await expect(applicationOf(PlainApplication)).resolves.toBeDefined();
  });

  it("no storage declared: a component that reaches Idempotency is refused at assembly, not at its first keyed call", async () => {
    @Application({
      name: "in-memory-application",
      modelProvider: TestModelProvider,
      version: "1.0.0",
      environment: KeysEnvironment,
      workflows: [BookOrderWorkflow],
      budgets: TEST_BUDGETS,
    })
    class InMemoryApplication {}

    await expect(applicationOf(InMemoryApplication)).rejects.toThrow(
      /\[application\.idempotency-key-required\] BookOrderAction reaches Idempotency.*declare a @DatabaseStorage and name the secret/su,
    );
  });

  it("no storage declared, a test's assembly (or one that runs no effect): the test's keys are given", async () => {
    @Application({
      name: "in-memory-test-application",
      version: "1.0.0",
      environment: KeysEnvironment,
      workflows: [BookOrderWorkflow],
      budgets: TEST_BUDGETS,
    })
    class InMemoryTestApplication {}

    await expect(
      applicationOf(InMemoryTestApplication, { withoutIdempotencyKeys: true }),
    ).resolves.toBeDefined();
  });

  it("no storage declared, no component that reaches Idempotency: assembles", async () => {
    @Application({
      name: "in-memory-plain-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [PlainWorkflow],
      budgets: TEST_BUDGETS,
    })
    class InMemoryPlainApplication {}

    await expect(applicationOf(InMemoryPlainApplication)).resolves.toBeDefined();
  });

  it("a service the application lists that reaches Idempotency — a component injects it by an abstract token — needs one too", async () => {
    @Injectable({ deps: [Idempotency] })
    class ChargingService {
      constructor(readonly idempotency: Idempotency) {}
    }

    expect(
      await violationsOf({
        storage: UNKEYED,
        workflows: [PlainWorkflow],
        providers: [ChargingService],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] ChargingService reaches Idempotency/u,
      ),
    );
  });

  it("a service that reaches the outbound-call store itself, past Idempotency, needs one too", async () => {
    @Injectable({ deps: [OutboundCallRepository] })
    class CallRowsService {
      constructor(readonly calls: OutboundCallRepository) {}
    }

    expect(
      await violationsOf({
        storage: UNKEYED,
        workflows: [PlainWorkflow],
        providers: [CallRowsService],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] CallRowsService reaches OutboundCallRepository/u,
      ),
    );
  });

  it("an abstract dependency given a listed class that reaches Idempotency: refused at assembly", async () => {
    @Injectable()
    class PaymentGateway {}
    @Injectable({ deps: [Idempotency] })
    class StripeGateway extends PaymentGateway {
      constructor(readonly idempotency: Idempotency) {
        super();
      }
    }
    @Injectable({ deps: [PaymentGateway] })
    class CheckoutService {
      constructor(readonly gateway: PaymentGateway) {}
    }

    expect(
      await violationsOf({
        storage: UNKEYED,
        workflows: [PlainWorkflow],
        providers: [CheckoutService, StripeGateway],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] CheckoutService reaches Idempotency/u,
      ),
    );
  });

  it("an InjectionToken whose value is a writer: refused at assembly", async () => {
    const WRITER = new InjectionToken<Idempotency>("WRITER");
    const writer: Idempotency = Object.create(Idempotency.prototype);
    @Injectable({ deps: [WRITER] })
    class ByTokenService {
      constructor(readonly writer: Idempotency) {}
    }

    expect(
      await violationsOf({
        storage: UNKEYED,
        workflows: [PlainWorkflow],
        providers: [ByTokenService, provide(WRITER, writer)],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] ByTokenService reaches Idempotency/u,
      ),
    );
  });

  it("named: it assembles", async () => {
    expect(await violationsOf({})).toEqual([]);
    expect(await violationsOf({ workflows: [ChargeOrderWorkflow] })).toEqual([]);
  });
});

describe("#825 AC6, AC7: no key is another key", () => {
  it.each([
    [
      "the PII key is the built-in providers' apiKey",
      { piiKeyField: "openRouterApiKey" },
      '[application.pii-key-shared] @Application piiKeyField "openRouterApiKey" is also the built-in OpenRouter providers\' apiKey',
    ],
  ] as const)("%s", async (_what, options, expected) => {
    const found = await violationsOf(options);
    expect(found).toContainEqual(expect.stringContaining(expected));
  });

  it("the storage's previous key on the variable of its current one: [storage.secret-shared]", async () => {
    @DatabaseStorage({
      driver: SqliteDriver.inMemory(),
      auditLogTtl: hours(24),
      ledgerEntriesTtl: hours(24),
      idempotencySecret: secret("KEYS_TEST_IDEMPOTENCY"),
      previousIdempotencySecret: secret("KEYS_TEST_IDEMPOTENCY"),
    })
    class SharedKeysStorage {}

    expect(await codesOf({ storage: SharedKeysStorage })).toEqual(["storage.secret-shared"]);
  });

  it("keys of their own: none of the rules", async () => {
    expect(await codesOf({ piiKeyField: "piiKeyOne" })).toEqual([]);
  });

  it("a field the contract lacks (a JavaScript caller): [environment.missing-field], naming the option", async () => {
    expect(
      await violationsOf({
        piiKeyField: "piiKey",
      }),
    ).toEqual([
      "[environment.missing-field] @Application piiKeyField needs piiKey: Secret in KeysEnvironment",
    ]);
  });
});

describe("#825 AC6: only a Secret field of the contract compiles", () => {
  it("a text field, a typo or a field of no contract does not compile", () => {
    const declare = () => {
      @Application({
        name: "typed-application",
        version: "1.0.0",
        environment: KeysEnvironment,
        workflows: [],
        // @ts-expect-error — label is a text field, not a Secret
        piiKeyField: "label",
      })
      class TypedApplication {}
      return TypedApplication;
    };

    expect(declare).toBeTypeOf("function");
  });
});

describe("#1317d: an idempotency secret that is named must resolve", () => {
  /** A storage whose current secret is an optional reference — reachable by a cast only. */
  const optionalStorage = () => {
    @DatabaseStorage({
      name: "optional-secret-storage",
      driver: SqliteDriver.inMemory(),
      auditLogTtl: hours(24),
      ledgerEntriesTtl: hours(24),
      idempotencySecret: secret.optional("OPTIONAL_IDEMPOTENCY") as never,
    })
    class OptionalStorage {}
    return OptionalStorage;
  };

  const assembledWith = async (workflows: ApplicationOptions["workflows"]) => {
    @Application({
      name: "optional-secret-application",
      version: "1.0.0",
      environment: KeysEnvironment,
      workflows,
      budgets: TEST_BUDGETS,
      storage: optionalStorage(),
    })
    class OptionalApplication {}
    return applicationOf(OptionalApplication);
  };

  it("a keyed runOnce and the variable unset or empty: the start fails with IdempotencyError.SecretKeyMissing", async () => {
    const assembled = await assembledWith([BookOrderWorkflow]);

    for (const env of [{}, { OPTIONAL_IDEMPOTENCY: "" }])
      expect(() => applicationIdempotencyKeysOf(assembled, {} as never, env)).toThrow(
        IdempotencyError.SecretKeyMissing,
      );
  });

  it("the variable set: it works; and no writer reachable: an unset secret is no failure", async () => {
    const assembled = await assembledWith([BookOrderWorkflow]);
    const plain = await assembledWith([PlainWorkflow]);

    expect(
      applicationIdempotencyKeysOf(assembled, {} as never, { OPTIONAL_IDEMPOTENCY: "one" }),
    ).toEqual({ fingerprintKeys: { current: "one" } });
    expect(() => applicationIdempotencyKeysOf(plain, {} as never, {})).not.toThrow();
  });
});

describe("#1317b: the test's idempotency keys are for tests only", () => {
  const keyedApplication = async () => {
    @Application({
      name: "test-keys-application",
      version: "1.0.0",
      environment: KeysEnvironment,
      workflows: [BookOrderWorkflow],
      budgets: TEST_BUDGETS,
      storage: KEYED,
    })
    class TestKeysApplication {}
    return { TestKeysApplication, assembled: await applicationOf(TestKeysApplication) };
  };

  it("createAppWith with a keyed runOnce and no secret declared fails the start — it is never given the test's keys", async () => {
    @Application({
      name: "no-secret-application",
      version: "1.0.0",
      environment: KeysEnvironment,
      workflows: [BookOrderWorkflow],
      budgets: TEST_BUDGETS,
    })
    class NoSecretApplication {}

    await expect(createAppWith(NoSecretApplication)).rejects.toThrow(/idempotency-key-required/u);
  });

  it("createAppWith with a declared secret whose variable is not set fails the start — no fallback key", async () => {
    const { TestKeysApplication } = await keyedApplication();

    await expect(
      createAppWith(TestKeysApplication, { env: "test", processEnv: {} }),
    ).rejects.toThrow("KEYS_TEST_IDEMPOTENCY is not set");
  });

  it("the keys of a test: a declared secret's unset variable gets them in the test's environment; the variable set is used as it is", async () => {
    const { assembled } = await keyedApplication();

    expect(applicationIdempotencyKeysOf(assembled, {} as never, {}, TEST_IDEMPOTENCY_KEYS)).toEqual(
      { fingerprintKeys: { current: TEST_IDEMPOTENCY_KEYS.current } },
    );
    expect(
      applicationIdempotencyKeysOf(
        assembled,
        {} as never,
        { KEYS_TEST_IDEMPOTENCY: "real" },
        TEST_IDEMPOTENCY_KEYS,
      ),
    ).toEqual({ fingerprintKeys: { current: "real" } });
    expect(() => applicationIdempotencyKeysOf(assembled, {} as never, {})).toThrow(
      "KEYS_TEST_IDEMPOTENCY is not set",
    );
  });

  it("a production process never gets them", async () => {
    const { assembled } = await keyedApplication();

    expect(() =>
      applicationIdempotencyKeysOf(
        assembled,
        {} as never,
        { NODE_ENV: "production" },
        TEST_IDEMPOTENCY_KEYS,
      ),
    ).toThrow(IdempotencyError.SecretKeyMissing);
    expect(
      applicationIdempotencyKeysOf(assembled, {} as never, {
        NODE_ENV: "production",
        KEYS_TEST_IDEMPOTENCY: "real",
      }),
    ).toEqual({ fingerprintKeys: { current: "real" } });
  });
});
