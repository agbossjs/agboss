import { expect, it } from "vitest";
import { testRag } from "@agboss/core/testing";
import { ShippingPolicyRag } from "../../../src/desk/rag/shipping-policy.rag.js";

it("testRag: the knowledge base alone, with topK", async () => {
  const { output } = await testRag(ShippingPolicyRag)("is a late order refunded?", { topK: 1 });

  expect(output.map((result) => result.source)).toEqual(["help/refunds.md"]);
});
