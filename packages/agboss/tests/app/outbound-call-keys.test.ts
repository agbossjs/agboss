/**
 * #825 — what `OutboundCalls` takes, at run time too (a JavaScript caller, a cast): a key the
 * framework made, never a copy of one (`{ ...key, token: key.token + 1 }` keeps the brand's type);
 * a call's request is always its fingerprint, so `FingerprintPolicy.None` on a call's key is
 * refused; a logger and a clock are required; options without a business key make no key.
 */
import { describe, expect, it } from "vitest";
import {
  effectKeyOf,
  FingerprintPolicy,
  FingerprintProblem,
  InMemoryOutboundCallRepository,
  NotSentTrust,
  OutboundCallReconciliation,
  OutboundCalls,
  OutboundCallSettings,
  type ExecutionContext,
  type EffectKeyFields,
} from "../../src/index.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { SilentLogger } from "../../src/infrastructure/logger.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";

const KEY = {
  scopeKey: "default:execution-1",
  tenantId: "default",
  leaseExecutionId: "execution-1",
  token: 1,
  idempotencyKey: "execution-1:charge-action:1",
  name: "charge",
};

const clock = new VirtualClock();

function parts() {
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "keys-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const store = new InMemoryOutboundCallRepository(clock, database, leases);
  return { store, settings: new OutboundCallSettings({ requiresMask: false }) };
}

const options = {
  target: "payments",
  operation: "charge",
  request: { amountUsd: 10 },
  send: () => ({}),
  notSent: { trust: NotSentTrust.Lookup } as const,
  reconcile: () => OutboundCallReconciliation.notSent(),
};

describe("#825: the key a call is sent under", () => {
  it("a copy of a key the framework made is refused before anything is recorded", async () => {
    const { store, settings } = parts();
    const calls = new OutboundCalls(store, settings, new SilentLogger(), clock);
    const fields: EffectKeyFields = effectKeyForTesting(KEY);
    const forged = { ...fields, token: 2 };

    // @ts-expect-error — a copy drops the key's mark: it does not compile (a JavaScript caller's runs)
    await expect(calls.send(forged, options)).rejects.toThrow(/not a key effectKeyOf made/u);
    expect(await store.findAllByTenantIdAndStatus({ ...STATUS, limit: 10 })).toEqual({ calls: [] });
  });

  it("FingerprintPolicy.None on a call's key is refused: its request is its fingerprint", async () => {
    const { store, settings } = parts();
    const calls = new OutboundCalls(store, settings, new SilentLogger(), clock);
    const none = effectKeyForTesting(KEY, {
      businessKey: "order:42",
      fingerprintPolicy: FingerprintPolicy.None,
    });

    await expect(calls.send(none, options)).rejects.toMatchObject({
      name: "FingerprintRequiredError",
      reason: FingerprintProblem.Contradictory,
    });
    // two requests under it: neither is recorded, so neither can replay the other
    expect(await store.findAllByTenantIdAndStatus({ ...STATUS, limit: 10 })).toEqual({ calls: [] });
  });

  it("a fingerprintPolicy on a step's own key is refused too: a call's key never says one", async () => {
    const { store, settings } = parts();
    const calls = new OutboundCalls(store, settings, new SilentLogger(), clock);
    const stepKey = effectKeyForTesting(KEY, { fingerprintPolicy: FingerprintPolicy.None });

    await expect(calls.send(stepKey, options)).rejects.toMatchObject({
      name: "FingerprintRequiredError",
      reason: FingerprintProblem.Contradictory,
    });
  });

  it("a JavaScript caller's OutboundCalls without a logger or a clock is refused", () => {
    const { store, settings } = parts();
    const build = (logger: unknown, at: unknown) => () =>
      new OutboundCalls(store, settings, logger as never, at as never);

    const refusal = new TypeError(
      "new OutboundCalls(repository, settings, logger, clock): a Logger and a Clock are required",
    );
    for (const [logger, at] of [
      [undefined, clock],
      [null, clock],
      [new SilentLogger(), undefined],
      [new SilentLogger(), null],
    ] as const)
      expect(build(logger, at)).toThrow(refusal);
    expect(build(new SilentLogger(), clock)).not.toThrow();
  });

  it("options without a business key make no key (a JavaScript caller)", () => {
    const executionContext = {
      executionId: "execution-1",
      step: { nodeId: "charge-action", visitNumber: 1, idempotencyKey: KEY.idempotencyKey },
      fence: { ...KEY },
    } as never as ExecutionContext;

    expect(() => effectKeyOf(executionContext, "charge", { fingerprint: 1 } as never)).toThrow(
      /options name no businessKey/u,
    );
  });
});

const STATUS = { tenantId: "default", status: "pending" as never };
