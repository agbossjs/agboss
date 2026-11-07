/**
 * #825 AC3 — `app.pendingOutboundCallsOf({ tenantId, limit?, after? })` reads a tenant's pending
 * calls a page at a time: `{ calls, next? }`, the calls shown as every read shows them (a business
 * key by its handle), `next` the cursor of the next page, none on the last; the default page is 100,
 * the largest 1000; a limit that is not a whole number from 1 to 1000, or an empty cursor, is
 * `dto.invalid` naming the field, before the store is read.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { gateway, resetGateway } from "./fixtures/payment-gateway.js";
import {
  ChargeOrderStart,
  InMemoryChargesApplication,
  resetRotation,
} from "./fixtures/rotation/rotation.application.js";

const test = testWith(InMemoryChargesApplication);

beforeEach(() => {
  resetGateway();
  resetRotation();
});

/** Leaves the charges of `orderIds` pending: each send fails with an error of unknown outcome. */
async function pendingCharges(app: Parameters<typeof execute>[0], orderIds: readonly string[]) {
  for (const orderId of orderIds) {
    gateway.failNext = 1;
    await expect(execute(app, ChargeOrderStart, { orderId, amountUsd: 10 })).rejects.toThrow();
  }
}

describe("#825 AC3: the pending calls, a page at a time", () => {
  test("five pending calls in pages of two: each once, in the order recorded, next on all but the last", async ({
    app,
  }) => {
    await pendingCharges(app, ["1", "2", "3", "4", "5"]);

    const one = await app.pendingOutboundCallsOf({ tenantId: "default", limit: 2 });
    const two = await app.pendingOutboundCallsOf({
      tenantId: "default",
      limit: 2,
      after: one.next,
    });
    const three = await app.pendingOutboundCallsOf({
      tenantId: "default",
      limit: 2,
      after: two.next,
    });
    const all = await app.pendingOutboundCallsOf({ tenantId: "default" });

    const orders = (page: typeof one) =>
      page.calls.map((call) => JSON.parse(call.request).orderId as string);
    expect([orders(one), orders(two), orders(three)]).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(three.next).toBeUndefined();
    expect(orders(all)).toEqual(["1", "2", "3", "4", "5"]);
    expect(all.next).toBeUndefined();
    // a business key by its handle only, as every read shows it (#508)
    expect(all.calls.every((call) => call.businessKey === undefined)).toBe(true);
    expect(all.calls[0]?.idempotencyKey).toMatch(/^business-key:[0-9a-f]{12}:charge$/u);
  });

  test("another tenant's pending calls are never on the page", async ({ app }) => {
    await pendingCharges(app, ["1"]);

    expect(await app.pendingOutboundCallsOf({ tenantId: "acme" })).toEqual({ calls: [] });
  });

  test.for([
    ["0", 0],
    ["a fraction", 1.5],
    ["above the largest page", 1001],
    ["not a number", Number.NaN],
  ] as const)(
    "a limit of %s is dto.invalid naming limit, the store unread",
    async ([, limit], { app }) => {
      await expect(
        app.pendingOutboundCallsOf({ tenantId: "default", limit }),
      ).rejects.toMatchObject({
        name: DtoValidationError.name,
        code: "dto.invalid",
        issues: [{ path: "limit", reason: "a page is a whole number of calls from 1 to 1000" }],
      });
    },
  );

  test("an empty cursor is dto.invalid naming after", async ({ app }) => {
    await expect(
      app.pendingOutboundCallsOf({ tenantId: "default", after: "" }),
    ).rejects.toMatchObject({ code: "dto.invalid", issues: [{ path: "after" }] });
  });

  test("a cursor the store never gave is dto.invalid naming after, never the store's RangeError", async ({
    app,
  }) => {
    for (const after of ["abc", "0", "1e3"])
      await expect(
        app.pendingOutboundCallsOf({ tenantId: "default", after }),
      ).rejects.toMatchObject({ code: "dto.invalid", issues: [{ path: "after" }] });
  });

  test("the largest page is taken as asked", async ({ app }) => {
    await pendingCharges(app, ["1"]);

    expect(
      (await app.pendingOutboundCallsOf({ tenantId: "default", limit: 1000 })).calls,
    ).toHaveLength(1);
  });
});
