/**
 * #505, #1317 — the largest request and result of a call (`maxPayloadSize` of `sendOnce`: a request
 * above it is neither recorded nor sent; a result above it leaves the intent marked as not stored),
 * and the recovery sweep, which removes ended intents whose expiry has come, on the `Clock` — never a
 * pending one. A call's `timeout` is refused when it is not a positive duration.
 */
import { OutboundCallError } from "../../src/core/error-families/effect-errors.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { OutboundCallRepository, OutboundCallStatus } from "../../src/index.js";
import { OutboundMasking } from "../../src/app/outbound-masking.js";
import { testWith } from "../../src/testing/index.js";
import { kilobytes, seconds, type Milliseconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { RecoveryLog, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ChargeWorkflow,
  ChargeWorkflowStart,
  OutboundCallApplication,
  resetRuns,
  runs,
} from "../app/fixtures/outbound-call.workflow.js";
import { gateway, resetGateway } from "../app/fixtures/payment-gateway.js";
import { IdempotencyKeyEnvironment } from "../helpers/idempotency-key.environment.js";

beforeEach(() => {
  resetLogged();
  resetGateway();
  resetRuns();
  resetRecovery();
});

const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

describe("#505, #1317: the outbound calls' masking at assembly", () => {
  it("a request is stored masked only where the application lists PII policies", async () => {
    @Application({
      name: "masking-application",
      version: "1.0.0",
      environment: IdempotencyKeyEnvironment,
      workflows: [ChargeWorkflow],
      budgets: TEST_BUDGETS,
    })
    class MaskingApplication {}

    const assembled = await applicationOf(MaskingApplication, { withoutIdempotencyKeys: true });

    expect(assembled.outboundMasking).toEqual(new OutboundMasking({ requiresMask: false }));
  });
});

@Application({
  name: "small-outbound-call-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  providers: [RecordingLogger],
})
class SmallOutboundCallApplication {}

const small = testWith(SmallOutboundCallApplication);
const test = testWith(OutboundCallApplication);

describe("#505: sendOnce's maxPayloadSize and the sweep read the settings", () => {
  small("a request above maxPayloadSize: nothing recorded, nothing sent", async ({ app }) => {
    runs.callOptions = { maxPayloadSize: kilobytes(1) };
    const call = execute(app, ChargeWorkflowStart, { text: "x".repeat(2000) });

    // a family's error is not wrapped by the action's step (decision 8)
    await expect(call).rejects.toBeInstanceOf(OutboundCallError.PayloadTooLarge);
    await expect(call).rejects.toMatchObject({ part: "request", maxPayloadSize: 1024 });
    expect(await app.outboundCallsOf(TREE)).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });

  small(
    "#508: a result above maxPayloadSize: the call happened — Completed with a marker in place of the result, the step gets the answer, never sent again",
    async ({ app }) => {
      gateway.padding = 2000;
      runs.callOptions = { maxPayloadSize: kilobytes(1) };

      const result = await execute(app, ChargeWorkflowStart, { text: "order-1" });

      expect(result.output).toMatchObject({ chargeId: expect.stringContaining("ch-order-1-1") });
      expect((await app.pendingOutboundCallsOf({ tenantId: "default" })).calls).toEqual([]);
      const [call] = await app.outboundCallsOf({
        tenantId: "default",
        rootExecutionId: result.executionId,
      });
      expect(call).toMatchObject({
        status: OutboundCallStatus.Completed,
        result: JSON.stringify({ "agboss:result-not-stored": "outbound-call.payload-too-large" }),
      });
      expect(gateway.calls).toHaveLength(1);
    },
  );

  small(
    "the recovery sweep removes the intents whose expiry has come, on the Clock",
    async ({ app, clock }) => {
      await app.ready();
      const removal = vi.spyOn(app.resolve(OutboundCallRepository), "deleteExpired");
      await execute(app, ChargeWorkflowStart, { text: "order-1" });

      await clock.advance(seconds(31));

      expect(removal).toHaveBeenCalledWith(clock.now());
    },
  );

  small("a store that fails to remove is logged as recovery.failed", async ({ app, clock }) => {
    await app.ready();
    vi.spyOn(app.resolve(OutboundCallRepository), "deleteExpired").mockRejectedValue(
      new Error("disk full"),
    );

    await clock.advance(seconds(31));

    expect(logged).toContainEqual(
      expect.objectContaining({
        code: "recovery.failed",
        message: "the expired outbound calls could not be removed: Error: disk full",
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

describe("#508 re-review HIGH1: the call's timeout", () => {
  for (const timeout of [0, -1, Number.NaN]) {
    test(`a timeout of ${String(timeout)} ms is refused: ConfigError.Option, nothing recorded, nothing sent`, async ({
      app,
    }) => {
      runs.callOptions = { timeout: timeout as Milliseconds };

      const failure = await execute(app, ChargeWorkflowStart, { text: "order-1" }).catch(
        (thrown: unknown) => thrown,
      );

      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).toContain(
        "not a positive duration",
      );
      expect(gateway.calls).toEqual([]);
    });
  }
});
