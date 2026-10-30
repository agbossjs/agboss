/**
 * #505 — `@Application({ outboundCalls })`: the largest request and result and the retention of
 * ended intents, checked at assembly (`[application.outbound-calls-invalid]`), read by
 * `OutboundCalls` (a request above `maxPayloadSize` is neither recorded nor sent; a result above it
 * leaves the intent pending, so the next attempt reconciles) and by the recovery sweep, which
 * removes ended intents past the retention on the `Clock` — never a pending one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import {
  EmptyEnvironment,
  OutboundCallPayloadTooLargeError,
  OutboundCallRepository,
  OutboundCallSettings,
  OutboundCallStatus,
  type OutboundCallsOptions,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, kilobytes, minutes, seconds, type Bytes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { RecoveryLog, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ChargeWorkflow,
  ChargeWorkflowStart,
  OutboundCallApplication,
  resetRuns,
} from "../app/fixtures/outbound-call.workflow.js";
import { gateway, resetGateway } from "../app/fixtures/payment-gateway.js";

beforeEach(() => {
  resetLogged();
  resetGateway();
  resetRuns();
  resetRecovery();
});

const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

const assembledWith = (outboundCalls: OutboundCallsOptions) => {
  @Application({
    name: "settings-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ChargeWorkflow],
    budgets: TEST_BUDGETS,
    outboundCalls,
  })
  class SettingsApplication {}
  return applicationOf(SettingsApplication);
};

describe("#505: @Application({ outboundCalls }) at assembly", () => {
  it("defaults to 64 KB and a week", async () => {
    const assembled = await assembledWith({});

    expect(assembled.outboundCalls).toEqual(new OutboundCallSettings());
    expect(assembled.outboundCalls).toMatchObject({
      maxPayloadSize: 65_536,
      retention: hours(168),
    });
  });

  it.each([0, -1])("a maxPayloadSize of %s bytes fails assembly", async (size) => {
    await expect(assembledWith({ maxPayloadSize: size as Bytes })).rejects.toThrow(
      `[application.outbound-calls-invalid] its outboundCalls.maxPayloadSize is ${String(size)} bytes, not a positive size`,
    );
  });

  it("a retention not above the lease's 30 s fails assembly, with the size's problem too", async () => {
    const assembly = assembledWith({ maxPayloadSize: kilobytes(0), retention: seconds(30) });

    await expect(assembly).rejects.toThrow(
      /outboundCalls.retention is 30000 ms, not above the lease's 30000 ms/,
    );
    await expect(assembly).rejects.toThrow(/maxPayloadSize is 0 bytes/);
  });

  it("takes what it sets", async () => {
    const assembled = await assembledWith({ maxPayloadSize: kilobytes(1), retention: seconds(31) });

    expect(assembled.outboundCalls).toMatchObject({ maxPayloadSize: 1024, retention: seconds(31) });
  });
});

@Application({
  name: "small-outbound-call-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  providers: [RecordingLogger],
  outboundCalls: { maxPayloadSize: kilobytes(1), retention: minutes(1) },
})
class SmallOutboundCallApplication {}

const small = testWith(SmallOutboundCallApplication);
const test = testWith(OutboundCallApplication);

describe("#505: OutboundCalls and the sweep read the settings", () => {
  small("a request above maxPayloadSize: nothing recorded, nothing sent", async ({ app }) => {
    const call = execute(app, ChargeWorkflowStart, { text: "x".repeat(2000) });

    await expect(call).rejects.toMatchObject({
      cause: expect.any(OutboundCallPayloadTooLargeError) as unknown,
    });
    await expect(call).rejects.toMatchObject({ cause: { part: "request", maxPayloadSize: 1024 } });
    expect(await app.outboundCallsOf(TREE)).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });

  small(
    "a result above maxPayloadSize: the call was answered, its intent stays pending",
    async ({ app }) => {
      gateway.padding = 2000;

      const call = execute(app, ChargeWorkflowStart, { text: "order-1" });

      await expect(call).rejects.toMatchObject({ cause: { part: "result", call: "charge" } });
      expect(await app.pendingOutboundCalls({ tenantId: "default" })).toHaveLength(1);
      expect(gateway.calls).toHaveLength(1);
    },
  );

  small(
    "the recovery sweep removes ended intents older than the retention, on the Clock",
    async ({ app, clock }) => {
      await app.ready();
      const removal = vi.spyOn(app.resolve(OutboundCallRepository), "deleteByEndedAtBefore");
      await execute(app, ChargeWorkflowStart, { text: "order-1" });

      await clock.advance(seconds(31));

      expect(removal).toHaveBeenCalledWith(new Date(clock.now().getTime() - minutes(1)));
    },
  );

  small("a store that fails to remove is logged as recovery.failed", async ({ app, clock }) => {
    await app.ready();
    vi.spyOn(app.resolve(OutboundCallRepository), "deleteByEndedAtBefore").mockRejectedValue(
      new Error("disk full"),
    );

    await clock.advance(seconds(31));

    expect(logged).toContainEqual(
      expect.objectContaining({
        code: "recovery.failed",
        message: "the ended outbound calls could not be removed: Error: disk full",
      }),
    );
  });
});

describe("#505: a provider that answers with an error", () => {
  test("the intent is Failed with the error's name, code and message; the step fails with it", async ({
    app,
  }) => {
    gateway.failNext = 1;

    await expect(execute(app, ChargeWorkflowStart, { text: "order-1" })).rejects.toThrow(
      /card declined for order-1/,
    );
    expect(await app.outboundCallsOf(TREE)).toEqual([
      expect.objectContaining({
        status: OutboundCallStatus.Failed,
        failure: {
          name: "PaymentDeclinedError",
          code: "PaymentDeclinedError",
          message: "card declined for order-1",
        },
      }),
    ]);
  });
});
