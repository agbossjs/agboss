/** #194: a cancelled run reaches its caller as `WorkflowCancelledError` (code `workflow.cancelled`). */
import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../src/testing/index.js";
import { AGBossError, WorkflowCancelledError } from "../../src/index.js";
import { Buyer, Checker, Order, ShopApplication } from "./fixtures.js";
import { execute } from "../helpers/flow.js";

const shop = testWith(ShopApplication);

describe("#194: a cancelled run is reported as WorkflowCancelledError", () => {
  shop(
    "aborting the run's signal mid-run rejects with WorkflowCancelledError",
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

      expect(error).toBeInstanceOf(WorkflowCancelledError);
      expect(error).toBeInstanceOf(AGBossError);
      expect(error).toMatchObject({ name: "WorkflowCancelledError", code: "workflow.cancelled" });
      expect(WorkflowCancelledError.code).toBe("workflow.cancelled");
      expect(mockLlm(Checker).requests).toHaveLength(0);
    },
  );

  shop("a signal aborted before the run starts rejects the same way", async ({ app }) => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execute(app, Order, { text: "buy a lamp" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: WorkflowCancelledError.code });
  });
});
