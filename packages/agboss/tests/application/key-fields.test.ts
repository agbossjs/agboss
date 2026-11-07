/**
 * #825 AC6, AC7 — the application's key fields. `piiKeyField`, `idempotencyKeyField` and
 * `previousIdempotencyKeyField` name `Secret` fields of the environment contract (a typo or a text
 * field does not compile; a field the contract lacks is `[environment.missing-field]` for a
 * JavaScript caller); none is another key — a model provider's `apiKey` (the built-ins'
 * `openRouterApiKey` when none is listed), the mesh's signing key, a `Secret` a listed class reads,
 * the other key fields (`[application.pii-key-shared]`, `[application.idempotency-key-shared]`); an
 * application whose components can write under a business key names an idempotency key
 * (`[application.idempotency-key-required]`).
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { Application } from "../../src/application/application.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { RotationEnvironment } from "../app/fixtures/rotation/environments/app.environment.js";
import {
  BookOrderWorkflow,
  ChargeOrderWorkflow,
} from "../app/fixtures/rotation/rotation.application.js";
import {
  Injectable,
  InjectionToken,
  provide,
  OutboundCalls,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  OutboundCallRepository,
  SqliteOutboundCallRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { start } from "../helpers/flow.js";
import type { ApplicationOptions } from "../../src/application/application.js";

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
  flow: [start(PlainStart).returns(WorkflowStartTextDto).toFinish(PlainFinish)],
})
class PlainWorkflow {}

/** `[code] message` of each rule an application of `options` breaks; `[]` when it assembles. */
async function violationsOf(options: Partial<ApplicationOptions>): Promise<readonly string[]> {
  @Application({
    name: "keys-application",
    version: "1.0.0",
    environment: RotationEnvironment,
    workflows: [BookOrderWorkflow],
    providers: [
      SqliteExecutionLeaseRepository,
      SqliteFencedEffectRepository,
      SqliteOutboundCallRepository,
    ],
    budgets: TEST_BUDGETS,
    idempotencyKeyField: "idempotencyKeyV1",
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
  it("a component that reaches a fenced-effect store, no idempotencyKeyField: refused, naming both", async () => {
    expect(await violationsOf({ idempotencyKeyField: undefined })).toEqual([
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] BookOrderAction reaches SqliteFencedEffectRepository, so it can write under a business key/u,
      ),
    ]);
  });

  it("one that reaches OutboundCalls too", async () => {
    expect(
      await violationsOf({ idempotencyKeyField: undefined, workflows: [ChargeOrderWorkflow] }),
    ).toEqual([
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] ChargeOrderAction reaches OutboundCalls/u,
      ),
    ]);
  });

  it("an application whose components reach neither needs none", async () => {
    @Application({
      name: "plain-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [PlainWorkflow],
      budgets: TEST_BUDGETS,
    })
    class PlainApplication {}

    await expect(applicationOf(PlainApplication)).resolves.toBeDefined();
  });

  it("a service the application lists that reaches OutboundCalls — a component injects it by an abstract token — needs one too", async () => {
    @Injectable({ deps: [OutboundCalls] })
    class ChargingService {
      constructor(readonly outboundCalls: OutboundCalls) {}
    }

    expect(
      await violationsOf({
        idempotencyKeyField: undefined,
        workflows: [PlainWorkflow],
        providers: [ChargingService],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] ChargingService reaches OutboundCalls/u,
      ),
    );
  });

  it("a service that reaches the outbound-call store itself, past OutboundCalls, needs one too", async () => {
    @Injectable({ deps: [OutboundCallRepository] })
    class CallRowsService {
      constructor(readonly calls: OutboundCallRepository) {}
    }

    expect(
      await violationsOf({
        idempotencyKeyField: undefined,
        workflows: [PlainWorkflow],
        providers: [CallRowsService],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] CallRowsService reaches OutboundCallRepository/u,
      ),
    );
  });

  it("an abstract dependency given a listed class that reaches OutboundCalls: refused at assembly", async () => {
    @Injectable()
    class PaymentGateway {}
    @Injectable({ deps: [OutboundCalls] })
    class StripeGateway extends PaymentGateway {
      constructor(readonly outboundCalls: OutboundCalls) {
        super();
      }
    }
    @Injectable({ deps: [PaymentGateway] })
    class CheckoutService {
      constructor(readonly gateway: PaymentGateway) {}
    }

    expect(
      await violationsOf({
        idempotencyKeyField: undefined,
        workflows: [PlainWorkflow],
        providers: [CheckoutService, StripeGateway],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] CheckoutService reaches OutboundCalls/u,
      ),
    );
  });

  it("an InjectionToken whose value is a writer: refused at assembly", async () => {
    const CALLS = new InjectionToken<OutboundCalls>("CALLS");
    const calls: OutboundCalls = Object.create(OutboundCalls.prototype);
    @Injectable({ deps: [CALLS] })
    class ByTokenService {
      constructor(readonly calls: OutboundCalls) {}
    }

    expect(
      await violationsOf({
        idempotencyKeyField: undefined,
        workflows: [PlainWorkflow],
        providers: [ByTokenService, provide(CALLS, calls)],
      }),
    ).toContainEqual(
      expect.stringMatching(
        /^\[application\.idempotency-key-required\] ByTokenService reaches OutboundCalls/u,
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
    [
      "the PII key is the idempotency key",
      { piiKeyField: "idempotencyKeyV1" },
      '[application.pii-key-shared] @Application piiKeyField "idempotencyKeyV1" is also the idempotencyKeyField',
    ],
    [
      "the PII key is the previous idempotency key",
      { piiKeyField: "idempotencyKeyV2", previousIdempotencyKeyField: "idempotencyKeyV2" },
      '[application.pii-key-shared] @Application piiKeyField "idempotencyKeyV2" is also the previousIdempotencyKeyField',
    ],
    [
      "the idempotency key is a provider's",
      { idempotencyKeyField: "openRouterApiKey" },
      '[application.idempotency-key-shared] @Application idempotencyKeyField "openRouterApiKey" is also the built-in OpenRouter providers\' apiKey',
    ],
    [
      "the previous key is the current one",
      { previousIdempotencyKeyField: "idempotencyKeyV1" },
      '[application.idempotency-key-shared] @Application previousIdempotencyKeyField "idempotencyKeyV1" is also the idempotencyKeyField',
    ],
    [
      "the idempotency key is the mesh's signing key",
      { mesh: { signingKey: "idempotencyKeyV1" } },
      '[application.idempotency-key-shared] @Application idempotencyKeyField "idempotencyKeyV1" is also the mesh\'s signingKey',
    ],
  ] as const)("%s", async (_what, options, expected) => {
    const found = await violationsOf(options);
    expect(found).toContainEqual(expect.stringContaining(expected));
  });

  it("keys of their own: none of the rules", async () => {
    expect(
      await codesOf({ piiKeyField: "idempotencyKeyV2", idempotencyKeyField: "idempotencyKeyV1" }),
    ).toEqual([]);
  });

  it("a field the contract lacks (a JavaScript caller): [environment.missing-field], naming the option", async () => {
    expect(
      await violationsOf({
        idempotencyKeyField: "idempotencyKey",
        piiKeyField: "piiKey",
      }),
    ).toEqual([
      "[environment.missing-field] @Application piiKeyField needs piiKey: Secret in RotationEnvironment",
      "[environment.missing-field] @Application idempotencyKeyField needs idempotencyKey: Secret in RotationEnvironment",
    ]);
  });
});

describe("#825 AC6: only a Secret field of the contract compiles", () => {
  it("a text field, a typo or a field of no contract does not compile", () => {
    const declare = () => {
      @Application({
        name: "typed-application",
        version: "1.0.0",
        environment: RotationEnvironment,
        workflows: [],
        // @ts-expect-error — sqlitePath is a text field, not a Secret
        piiKeyField: "sqlitePath",
        // @ts-expect-error — a typo of a Secret field
        idempotencyKeyField: "idempotencyKeyV3",
        previousIdempotencyKeyField: "idempotencyKeyV2",
      })
      class TypedApplication {}
      return TypedApplication;
    };

    expect(declare).toBeTypeOf("function");
  });
});
