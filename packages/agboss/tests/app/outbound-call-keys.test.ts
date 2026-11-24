/**
 * #825 — what `Idempotency.sendOnce` takes, at run time too (a JavaScript caller, a cast): the key
 * is the step's own, never one given (so a copy of a key is no longer a way in); a call's request is
 * always its fingerprint, so a fingerprint a caller gives is not read; a logger and a clock are
 * required; options without a business key make no key.
 */
import { describe, expect, it } from "vitest";
import {
  Idempotency,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  OutboundRecovery,
  Reconciliation,
} from "../../src/index.js";
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { OutboundCallSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import { effectKeyOf } from "../../src/stores/index.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { SilentLogger } from "../../src/infrastructure/logger.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { testExecutionContext } from "../../src/testing/execution-context.js";
import { storeClockOf } from "../helpers/store-clock.js";
import { outboundFrame, type OutboundSendCase } from "../helpers/outbound-frame.js";

const clock = new VirtualClock();

function parts() {
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "keys-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), application, database);
  const store = new InMemoryOutboundCallRepository(storeClockOf(clock), database, leases);
  const effects = new InMemoryFencedEffectRepository(storeClockOf(clock), database, leases);
  return { effects, store, settings: new OutboundCallSettings({ requiresMask: false }) };
}

const options: OutboundSendCase<{ amountUsd: number }, object> = {
  target: "payments",
  operation: "charge",
  request: { amountUsd: 10 },
  send: () => ({}),
  recovery: OutboundRecovery.permanentLookup(() => Reconciliation.notExecuted()),
};

describe("#825: the key a call is sent under", () => {
  it("a fingerprint or a withoutFingerprint a JavaScript caller gives is not read: the request is the call's fingerprint", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1", "order:42");
    // a JavaScript caller's options: a call has no fingerprint of its own to say
    const said = { ...options, fingerprint: { version: 1 }, withoutFingerprint: true } as never;

    await frame.send(key, said);
    const other = frame.send(key, { ...(said as object), request: { amountUsd: 12 } } as never);

    // two requests under one business key: the second is a conflict, never a replay of the first
    await expect(other).rejects.toBeInstanceOf(IdempotencyError.KeyConflict);
  });

  it("a JavaScript caller's Idempotency without a logger or a clock is refused", () => {
    const { effects, store, settings } = parts();
    const build = (logger: unknown, at: unknown) => () =>
      new Idempotency(effects, store, settings, logger as never, at as never);

    const refusal = new TypeError("new Idempotency(…): a Logger and a Clock are required");
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
    const executionContext = testExecutionContext({ executionId: "execution-1" });

    expect(() => effectKeyOf(executionContext, "charge", { fingerprint: 1 } as never)).toThrow(
      /options name no businessKey/u,
    );
  });
});
