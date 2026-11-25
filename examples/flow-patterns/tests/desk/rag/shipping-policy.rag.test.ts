import { expect, it } from "vitest";
import { testUnit } from "@agboss/core/testing";
import { ShippingPolicyRag } from "../../../src/desk/rag/shipping-policy.rag.js";

it("testUnit: the knowledge base alone, with topK", async () => {
  const { output } = await testUnit(ShippingPolicyRag)("is a late order refunded?", { topK: 1 });

  expect(output.map((result) => result.source)).toEqual(["help/refunds.md"]);
});
