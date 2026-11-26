/**
 * #1324b, #825: a variable of the database storage's `piiSecret` / `idempotencySecret` (or their
 * previous keys) is read by nothing else in the application — `[storage.secret-shared]` — so
 * rotating a provider's or the mesh's key never changes every stored token or fingerprint. Two model
 * providers that share a key are fine.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import {
  DatabaseStorage,
  Mesh,
  MeshInboundMode,
  secret,
  SqliteDriver,
  defineEnv,
  env,
} from "../../src/index.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
} from "../../src/models/index.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { BookOrderWorkflow } from "../app/fixtures/rotation/rotation.application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

const provider = (name: string, apiKey: ReturnType<typeof secret>): Class => {
  @ModelProvider({
    name,
    description: "A server",
    driver: OpenAiCompatibleDriver({ baseUrl: "http://server.test/v1", apiKey }),
    timeout: seconds(5),
    cost: ModelCost.fromResponse(),
    reasoning: Reasoning.modelDecides(),
    promptCaching: PromptCaching.off(),
  })
  class Provider {}
  return Provider;
};

const storage = (secrets: Record<string, ReturnType<typeof secret>>): Class => {
  @DatabaseStorage({
    name: "shared-storage",
    driver: SqliteDriver.inMemory(),
    auditLogTtl: hours(1),
    ledgerEntriesTtl: hours(1),
    idempotencySecret: secret("DEFAULT_IDEMPOTENCY"),
    ...secrets,
  })
  class SharedStorage {}
  return SharedStorage;
};

const mesh = (signingKey: ReturnType<typeof secret>): Class => {
  @Mesh({
    name: "shared-mesh",
    signingKey,
    inboundMode: MeshInboundMode.AllowExternal,
    deduplicationTtl: minutes(30),
    maxHops: 4,
  })
  class SharedMesh {}
  return SharedMesh;
};

async function violationsOf(options: {
  readonly storage: Class;
  readonly providers?: readonly Class[];
  readonly mesh?: Class;
}): Promise<readonly string[]> {
  @Application({
    name: "shared-application",
    version: "1.0.0",
    workflows: [BookOrderWorkflow],
    budgets: TEST_BUDGETS,
    storage: options.storage,
    providers: [...(options.providers ?? [])],
    ...(options.mesh === undefined ? {} : { mesh: options.mesh }),
  })
  class SharedApplication {}
  try {
    await applicationOf(SharedApplication, { withoutIdempotencyKeys: true });
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError.GraphRules)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

describe("#1324b: [storage.secret-shared] across the application", () => {
  it("piiSecret on a model provider's apiKey: refused, naming both, never a value", async () => {
    const found = await violationsOf({
      storage: storage({ piiSecret: secret("SHARED_KEY") }),
      providers: [provider("one-model-provider", secret("SHARED_KEY"))],
    });

    expect(found).toEqual([
      expect.stringMatching(
        /^\[storage\.secret-shared\] the storage's piiSecret reads SHARED_KEY, as Provider\.driver\.settings\.apiKey does/u,
      ),
    ]);
    expect(found.join()).not.toContain("http://server.test");
  });

  it("idempotencySecret on a provider's apiKey: refused", async () => {
    const found = await violationsOf({
      storage: storage({ idempotencySecret: secret("SHARED_KEY") }),
      providers: [provider("two-model-provider", secret("SHARED_KEY"))],
    });

    expect(found.join("\n")).toMatch(/idempotencySecret reads SHARED_KEY, as Provider\.driver/u);
  });

  it("previousPiiSecret and previousIdempotencySecret count too", async () => {
    const found = await violationsOf({
      storage: storage({
        piiSecret: secret("OWN_PII"),
        previousPiiSecret: secret("SHARED_KEY"),
        idempotencySecret: secret("OWN_IDEM"),
        previousIdempotencySecret: secret("SHARED_KEY_TWO"),
      }),
      providers: [
        provider("three-model-provider", secret("SHARED_KEY")),
        provider("four-model-provider", secret("SHARED_KEY_TWO")),
      ],
    });

    expect(found).toHaveLength(2);
  });

  it("piiSecret on the mesh's signingKey: refused", async () => {
    const found = await violationsOf({
      storage: storage({ piiSecret: secret("SHARED_KEY") }),
      mesh: mesh(secret("SHARED_KEY")),
    });

    expect(found.join("\n")).toMatch(/piiSecret reads SHARED_KEY, as @Mesh\.signingKey does/u);
  });

  it("a variable shared through a defineEnv reference is found as well", async () => {
    const appEnv = defineEnv({ key: secret("SHARED_KEY"), url: env("SHARED_KEY_URL") });
    const found = await violationsOf({
      storage: storage({ piiSecret: appEnv.key }),
      providers: [provider("five-model-provider", appEnv.key)],
    });

    expect(found).toHaveLength(1);
  });

  it("a storage secret on another storage secret is still the storage's own rule", async () => {
    const found = await violationsOf({
      storage: storage({ piiSecret: secret("SAME"), idempotencySecret: secret("SAME") }),
    });

    expect(found).toEqual([
      expect.stringMatching(
        /^\[storage\.secret-shared\] the storage's piiSecret reads SAME, as its idempotencySecret/u,
      ),
    ]);
  });

  it("keys of their own, and two model providers on one key: no violation", async () => {
    const found = await violationsOf({
      storage: storage({ piiSecret: secret("OWN_PII"), idempotencySecret: secret("OWN_IDEM") }),
      providers: [
        provider("six-model-provider", secret("OPENROUTER_API_KEY")),
        provider("seven-model-provider", secret("OPENROUTER_API_KEY")),
      ],
      mesh: mesh(secret("OWN_SIGNING")),
    });

    expect(found).toEqual([]);
    expect(TestModelProvider).toBeDefined();
  });
});
