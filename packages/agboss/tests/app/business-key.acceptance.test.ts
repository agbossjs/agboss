/**
 * #508 acceptance corner cases of business keys: the 200-character boundary of `order:<id>`, keys
 * that differ only by case or Unicode form, a key with a lone surrogate (no string a store or the
 * provider's idempotency key can hold), and a key that only looks like another.
 */
import { beforeEach, describe, expect } from "vitest";
import { InvalidBusinessKeyError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { execute } from "../helpers/flow.js";
import {
  BusinessKeyApplication,
  ChargeOrderStart,
  ledger,
  resetLedger,
  SendChargeStart,
} from "./fixtures/business-key.workflow.js";
import { gateway, resetGateway } from "./fixtures/payment-gateway.js";

const test = testWith(BusinessKeyApplication);

beforeEach(() => {
  resetLedger();
  resetGateway();
  resetRecovery();
});

/** `order:<orderId>` is 6 characters plus the id. */
const ID_AT_LIMIT = "9".repeat(200 - "order:".length);

describe("#508 acceptance: the business key's boundaries", () => {
  test("a key of exactly 200 characters is charged; 201 is InvalidBusinessKeyError, nothing charged", async ({
    app,
  }) => {
    const charged = await execute(app, ChargeOrderStart, { orderId: ID_AT_LIMIT, amountUsd: 10 });
    const refused = await execute(app, ChargeOrderStart, {
      orderId: `${ID_AT_LIMIT}9`,
      amountUsd: 10,
    }).catch((thrown: unknown) => thrown);

    expect(charged.output).toMatchObject({ chargeId: expect.any(String) });
    await expect(Promise.reject(refused as Error)).rejects.toFailWith(InvalidBusinessKeyError, {});
    expect(ledger.charges).toHaveLength(1);
  });

  test("keys that differ only by case, or by Unicode form, are two orders: two charges", async ({
    app,
  }) => {
    await execute(app, ChargeOrderStart, { orderId: "ab", amountUsd: 10 });
    await execute(app, ChargeOrderStart, { orderId: "AB", amountUsd: 10 });
    await execute(app, ChargeOrderStart, { orderId: "café", amountUsd: 10 });
    await execute(app, ChargeOrderStart, { orderId: "café", amountUsd: 10 });

    expect(ledger.charges).toHaveLength(4);
  });

  test("a key with an emoji and non-Latin text is one order across two executions", async ({
    app,
  }) => {
    const first = await execute(app, ChargeOrderStart, {
      orderId: "заказ-\u{1F9FE}",
      amountUsd: 10,
    });
    const second = await execute(app, ChargeOrderStart, {
      orderId: "заказ-\u{1F9FE}",
      amountUsd: 10,
    });

    expect(second.output).toEqual(first.output);
    expect(ledger.charges).toHaveLength(1);
  });

  test("a lone surrogate in a workflow's input is refused at the boundary: nothing charged or sent", async ({
    app,
  }) => {
    const error = await execute(app, SendChargeStart, { orderId: "42\ud800", amountUsd: 10 }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ message: expect.stringContaining("lone surrogate") });
    expect(ledger.charges).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });
});
