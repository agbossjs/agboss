import { expect, it } from "vitest";
import { testPii } from "@agboss/core/testing";
import { CustomerIdPiiPolicy } from "../../../src/desk/pii-policies/customer-id.pii-policy.js";

it("testPii: a project detector masks for the model and reveals back", async () => {
  const pii = testPii([CustomerIdPiiPolicy]);

  const { output: masked } = await pii.mask("CUS-1234 asks about #7");

  expect(masked).not.toContain("CUS-1234");
  expect(pii.reveal(masked)).toBe("CUS-1234 asks about #7");
});
