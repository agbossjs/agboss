/** #194: a cancelled run reaches its caller as `ExecutionCancelledError` (code `execution.cancelled`). */
import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../src/testing/index.js";
import { AGBossError, ExecutionCancelledError } from "../../src/index.js";
import { Buyer, Checker, Order, ShopApplication } from "./fixtures.js";
import { execute } from "../helpers/flow.js";

const shop = testWith(ShopApplication);

describe("#194: a cancelled run is reported as ExecutionCancelledError", () => {
  shop(
    "aborting the run's signal mid-run rejects with ExecutionCancelledError",
    async ({ app, mockLlm }) => {
      const controller = new AbortController();
      mockLlm(Buyer).thenAnswer(() => {
        controller.abort();
        return replyWith("bought");
      });

      const error: unknown = await execute(
        app,
        Order,
        { text: "buy a lamp" },
        { signal: controller.signal },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExecutionCancelledError);
      expect(error).toBeInstanceOf(AGBossError);
      expect(error).toMatchObject({ name: "ExecutionCancelledError", code: "execution.cancelled" });
      expect(ExecutionCancelledError.code).toBe("execution.cancelled");
      expect(mockLlm(Checker).requests).toHaveLength(0);
    },
  );

  shop("a signal aborted before the run starts rejects the same way", async ({ app }) => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execute(app, Order, { text: "buy a lamp" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: ExecutionCancelledError.code });
  });
});
