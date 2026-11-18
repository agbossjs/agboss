/**
 * #1150 bug 4 — a child's outbound call is stored masked by its chain's PII policies, not by its own
 * workflow's alone: the root lists `order-id-pii-policy`, the child lists none — in its parent's
 * step and on another instance alike.
 */
import { beforeEach, describe, expect } from "vitest";
import { ChildExecutionQueueRepository } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  ChainChargeApplication,
  ChainFarChargeStart,
  ChainNearChargeStart,
} from "./fixtures/chain-charge.application.js";
import { gateway, resetGateway } from "./fixtures/payment-gateway.js";

const MASKED = '{"orderId":"<order-id>","amountUsd":10,"email":"<email>"}';
const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

beforeEach(() => {
  resetGateway();
  resetRecovery();
});

const near = testWith(ChainChargeApplication);

describe("#1150 AC3: a child's outbound call under its chain", () => {
  near(
    "AC3: a ParentInstance child's stored request is masked by its root's policy too",
    async ({ app }) => {
      await execute(app, ChainNearChargeStart, { text: "order-7 alice@example.com" });

      const [call] = await app.outboundCallsOf(TREE);

      expect(call?.workflow).toBe("child-charge-workflow");
      expect(call?.request).toBe(MASKED);
      expect(gateway.calls).toHaveLength(1);
    },
  );
});

const far = testWith(ChainChargeApplication, { instances: 2 });

describe("#1150 AC4: an AnyInstance child's outbound call on another instance", () => {
  far("AC4: stored masked by the chain whose names its launch carried", async ({ apps }) => {
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("two instances");
    await b.ready();
    await a.ready();
    // only the other instance claims the child
    a.resolve(ChildExecutionQueueRepository).claimFirstByStatusQueuedOrderByDepthDesc = () =>
      Promise.resolve(undefined);

    const result = await execute(a, ChainFarChargeStart, { text: "order-7 alice@example.com" });
    const [call] = await a.outboundCallsOf(TREE);

    expect(result.output).toEqual({ chargeId: "ch-order-7-1" });
    expect(call?.workflow).toBe("chain-far-charge-child-workflow");
    expect(call?.request).toBe(MASKED);
  });
});
