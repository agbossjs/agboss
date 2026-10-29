import { expect, it } from "vitest";
import { testTool } from "@agboss/core/testing";
import { OrderStatusTool } from "../../../src/desk/tools/order-status.tool.js";

it("testTool: the tool on its own container, its output validated", async () => {
  const { output } = await testTool(OrderStatusTool)({ orderId: "7" });

  expect(output.status).toMatch(/^order 7 shipped/u);
});
