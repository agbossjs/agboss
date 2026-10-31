/**
 * #505 acceptance corner cases of `maxPayloadSize`: a request whose stored JSON is exactly the limit
 * is recorded and sent, one byte more is neither; the size is UTF-8 bytes, not characters; the
 * error names the call and the sizes, never the request.
 */
import { beforeEach, describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment, OutboundCallPayloadTooLargeError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { kilobytes, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { RecoveryLog, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ChargeWorkflow,
  ChargeWorkflowStart,
  resetRuns,
} from "../app/fixtures/outbound-call.workflow.js";
import { gateway, resetGateway } from "../app/fixtures/payment-gateway.js";

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

@Application({
  name: "edge-outbound-call-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  outboundCalls: { maxPayloadSize: kilobytes(1), retention: minutes(1) },
})
class EdgeOutboundCallApplication {}

const test = testWith(EdgeOutboundCallApplication);

/** The request's JSON around the order id: `{"orderId":"…","amountUsd":10}`. */
const FRAME = JSON.stringify({ orderId: "", amountUsd: 10 }).length;

describe("#505 acceptance: a request at maxPayloadSize", () => {
  test("exactly 1024 bytes is recorded and sent", async ({ app }) => {
    const orderId = "o".repeat(1024 - FRAME);

    await execute(app, ChargeWorkflowStart, { text: orderId });

    expect(gateway.calls).toHaveLength(1);
  });

  test("1025 bytes is OutboundCallPayloadTooLargeError, nothing sent, the request not in the error", async ({
    app,
  }) => {
    const orderId = "o".repeat(1025 - FRAME);

    const error: unknown = await execute(app, ChargeWorkflowStart, { text: orderId }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({
      cause: expect.any(OutboundCallPayloadTooLargeError) as unknown,
    });
    expect(error).toMatchObject({ cause: { part: "request", size: 1025, maxPayloadSize: 1024 } });
    expect(JSON.stringify(error) + String(error)).not.toContain(orderId.slice(0, 64));
    expect(gateway.calls).toEqual([]);
  });

  test("the limit is UTF-8 bytes: half as many two-byte characters already pass it", async ({
    app,
  }) => {
    const orderId = "é".repeat(Math.ceil((1025 - FRAME) / 2));

    await expect(execute(app, ChargeWorkflowStart, { text: orderId })).rejects.toMatchObject({
      cause: expect.any(OutboundCallPayloadTooLargeError) as unknown,
    });
    expect(gateway.calls).toEqual([]);
  });
});
