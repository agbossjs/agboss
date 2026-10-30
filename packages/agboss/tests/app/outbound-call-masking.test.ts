/**
 * #505 — an outbound call's request is stored masked wherever its step runs: a child workflow in
 * its parent's step (`ParentInstance`) and a child queued for any instance (`AnyInstance`, whose
 * run context is rebuilt by the worker — it used to carry no mask, so its intent was stored raw).
 * A frame without a mask while the application lists PII policies fails closed: nothing recorded,
 * nothing sent. An operator reads a stored result masked too (the store keeps it as given, for the
 * replay).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  OutboundCallRepository,
  OutboundCallSettings,
  OutboundCallUnmaskedError,
  Workflow,
  WorkflowStart,
} from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { start } from "../helpers/flow.js";
import { applicationOf } from "../../src/application/assemble.js";
import { testAction, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  FarChargeWorkflowStart,
  NearChargeWorkflowStart,
  OutboundCallChildrenApplication,
  UnmaskedChargeAction,
  unmasked,
} from "./fixtures/outbound-call-children.workflow.js";
import {
  ChargedWorkflowFinish,
  ChargeOrderAction,
  ChargeReceiptDto,
  ChargeWorkflow,
  ChargeWorkflowStart,
  EmailPiiPolicy,
  OutboundCallApplication,
} from "./fixtures/outbound-call.workflow.js";
import { gateway, PaymentGateway, resetGateway } from "./fixtures/payment-gateway.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

const test = testWith(OutboundCallChildrenApplication);

@WorkflowStart({
  name: "masked-charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
class MaskedChargeWorkflowStart {}

beforeEach(() => {
  resetGateway();
  resetRecovery();
  unmasked.pendingAfter.length = 0;
});

const MASKED_REQUEST = '{"orderId":"order-7","amountUsd":10,"email":"<email>"}';

/** The calls of the one child of `rootExecutionId`'s tree (the root is execution-1). */
const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

describe("#505 AC4: a child workflow's outbound call is stored masked", () => {
  test("AC4: an AnyInstance child with a PII policy sends a call: its stored request is masked", async ({
    app,
  }) => {
    const result = await execute(app, FarChargeWorkflowStart, {
      text: "order-7 alice@example.com",
    });

    const [call] = await app.outboundCallsOf(TREE);

    expect(result.output).toEqual({ chargeId: "ch-order-7-1" });
    expect(call?.executionId).not.toBe("execution-1");
    expect(call?.request).toBe(MASKED_REQUEST);
    expect(gateway.calls).toHaveLength(1);
  });

  test("AC4: a ParentInstance child's stored request is masked the same way", async ({ app }) => {
    await execute(app, NearChargeWorkflowStart, { text: "order-7 alice@example.com" });

    const [call] = await app.outboundCallsOf(TREE);

    expect(call?.request).toBe(MASKED_REQUEST);
  });
});

describe("#505: no mask where policies exist — fail closed", () => {
  it("AC4: a frame without a mask while the application lists policies: refused, nothing recorded or sent", async () => {
    const run = testAction(UnmaskedChargeAction);

    const refused = run({ message: { value: { text: "order-1" } } });

    await expect(refused).rejects.toBeInstanceOf(OutboundCallUnmaskedError);
    await expect(refused).rejects.toMatchObject({ code: "outbound-call.unmasked", call: "charge" });
    expect(unmasked.pendingAfter).toEqual([0]);
    expect(gateway.calls).toEqual([]);
  });

  it("the assembly asks for a mask when the application lists PII policies, and not when none does", async () => {
    @Application({
      name: "no-pii-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [ChargeWorkflow],
      budgets: TEST_BUDGETS,
    })
    class NoPiiApplication {}

    const withPolicies = await applicationOf(OutboundCallApplication);
    const without = await applicationOf(NoPiiApplication);

    expect(withPolicies.outboundCalls.requiresMask).toBe(true);
    expect(without.outboundCalls.requiresMask).toBe(false);
    expect(new OutboundCallSettings().requiresMask).toBe(false);
  });
});

const plain = testWith(OutboundCallApplication);

describe("#505 AC4: an operator reads a stored result masked", () => {
  plain(
    "a result with personal data is shown masked; the step got it as it is",
    async ({ app }) => {
      gateway.receiptEmail = "bob@example.com";

      const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });
      const [call] = await app.outboundCallsOf(TREE);

      expect(result.output).toEqual({ chargeId: "ch-order-7-1 bob@example.com" });
      expect(call?.result).toBe('{"chargeId":"ch-order-7-1 <email>"}');
    },
  );
});

@Workflow({
  name: "masked-charge-workflow",
  version: "1.0.0",
  flow: [
    start(MaskedChargeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChargeOrderAction)
      .returns(ChargeReceiptDto)
      .toFinish(ChargedWorkflowFinish),
  ],
  providers: [PaymentGateway],
  piiPolicies: [EmailPiiPolicy],
})
class MaskedChargeWorkflow {}

/** The e-mail policy on the workflow only: the application's own mask would leave it as it is. */
@Application({
  name: "workflow-policy-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MaskedChargeWorkflow],
  budgets: TEST_BUDGETS,
})
class WorkflowPolicyApplication {}

const ownPolicy = testWith(WorkflowPolicyApplication);

describe("#505 AC4: an operator reads a call masked by its own workflow's policies", () => {
  ownPolicy(
    "AC4: a workflow-level PII policy masks a result in outboundCallsOf",
    async ({ app }) => {
      gateway.receiptEmail = "bob@example.com";

      await execute(app, MaskedChargeWorkflowStart, { text: "order-7" });
      const [call] = await app.outboundCallsOf(TREE);

      expect(call?.workflow).toBe("masked-charge-workflow");
      expect(call?.result).toBe('{"chargeId":"ch-order-7-1 <email>"}');
    },
  );

  ownPolicy(
    "AC4: a failure message with an e-mail is stored masked and read masked",
    async ({ app }) => {
      gateway.failNext = 1;

      await expect(
        execute(app, MaskedChargeWorkflowStart, { text: "alice@example.com" }),
      ).rejects.toThrow(/card declined for alice@example.com/);
      const stored = await app
        .resolve(OutboundCallRepository)
        .findAllByTenantIdAndRootExecutionId("default", "execution-1");
      const [read] = await app.outboundCallsOf(TREE);

      expect(stored[0]?.failure?.message).toBe("card declined for <email>");
      expect(read?.failure).toEqual({
        name: "PaymentDeclinedError",
        code: "PaymentDeclinedError",
        message: "card declined for <email>",
      });
    },
  );
});

describe("#505 AC4: masked when written — the store holds no raw personal data", () => {
  ownPolicy(
    "AC4: the stored intent itself is masked by the workflow's policy: request and result",
    async ({ app }) => {
      gateway.receiptEmail = "bob@example.com";

      const result = await execute(app, MaskedChargeWorkflowStart, {
        text: "order-7 alice@example.com",
      });
      const [stored] = await app
        .resolve(OutboundCallRepository)
        .findAllByTenantIdAndRootExecutionId("default", "execution-1");

      expect(result.output).toEqual({ chargeId: "ch-order-7-1 bob@example.com" });
      expect(stored?.request).toBe('{"orderId":"order-7","amountUsd":10,"email":"<email>"}');
      expect(stored?.result).toBe('{"chargeId":"ch-order-7-1 <email>"}');
    },
  );
});

describe("#505: what reconcile and a replay get", () => {
  it("reconcile gets the stored, masked request and the key; send got the real request", async () => {
    const run = testAction(ChargeOrderAction);
    gateway.gates.after = 1;
    const first = run({ message: { value: { text: "order-7 alice@example.com" } } } as never, {
      timeout: seconds(1),
    });
    first.catch(() => undefined);
    await run.clock.advance(seconds(1));
    await expect(first).rejects.toThrow();

    await run({ message: { value: { text: "order-7 alice@example.com" } } } as never);

    expect(gateway.storedRequests).toEqual([
      '{"orderId":"order-7","amountUsd":10,"email":"alice@example.com"}',
    ]);
    expect(gateway.lookups).toEqual([
      { idempotencyKey: "test-execution:charge-order-action:1:charge", attempt: 1 },
    ]);
  });
});
