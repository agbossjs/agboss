import { describe, expect, it } from "vitest";
import { ToolCallDecision } from "@agboss/core";
import { testToolInterceptor } from "@agboss/core/testing";
import { DeskAuditToolInterceptor } from "../../../src/desk/tool-interceptors/desk-audit.tool-interceptor.js";
import { CloseAccountTool } from "../../../src/desk/tools/close-account.tool.js";
import { OrderStatusTool } from "../../../src/desk/tools/order-status.tool.js";

/** An extension point alone, on its own container (#262 S55): the unit runner. */

describe("testToolInterceptor: the decision and the output, per tool", () => {
  const interceptor = testToolInterceptor(DeskAuditToolInterceptor);

  it("blocks a closure, answers for an archived order, allows the rest", async () => {
    const closure = await interceptor.beforeToolCall(CloseAccountTool, { customerId: "c-1" });
    const archived = await interceptor.beforeToolCall(OrderStatusTool, { orderId: "A-1" });
    const recent = await interceptor.beforeToolCall(OrderStatusTool, { orderId: "7" });

    expect(closure.output).toEqual(
      ToolCallDecision.block({ reason: "accounts are closed by the back office only" }),
    );
    expect(archived.output).toEqual(
      ToolCallDecision.replyToModel({
        message: "Order A-1 is archived: ask the customer for a recent one.",
      }),
    );
    expect(recent.output).toEqual(ToolCallDecision.allow());
  });

  it("cuts the internal note from a status", async () => {
    const { output } = await interceptor.afterToolCall(
      OrderStatusTool,
      { orderId: "7" },
      { status: "order 7 shipped | internal: ticket 88" },
    );

    expect(output).toEqual({ status: "order 7 shipped" });
  });
});
