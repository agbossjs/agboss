import { describe, expect, it } from "vitest";
import { CreditService } from "../../../src/credit/services/credit.service.js";

describe("the credit service", () => {
  it("the credit service gives big spenders a higher limit", async () => {
    const service = new CreditService();

    await expect(service.limitOf({ customerId: "big-spender", requestKey: "k" })).resolves.toBe(
      10_000,
    );
    await expect(service.limitOf({ customerId: "c-1", requestKey: "k" })).resolves.toBe(100);
  });
});
