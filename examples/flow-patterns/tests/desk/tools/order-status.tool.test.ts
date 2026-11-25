import { expect, it } from "vitest";
import { testUnit } from "@agboss/core/testing";
import { OrderStatusTool } from "../../../src/desk/tools/order-status.tool.js";

it("testUnit: the tool on its own container, its output validated", async () => {
  const { output } = await testUnit(OrderStatusTool)({ orderId: "7" });

  expect(output.status).toMatch(/^order 7 shipped/u);
});
