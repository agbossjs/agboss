/** #194, #1341: a cancelled run reaches its caller as `ExecutionStatus.Cancelled`, never as an error. */
import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../src/testing/index.js";
import { AGBossError } from "../../src/index.js";
import { Buyer, Checker, Order, ShopApplication } from "./fixtures.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const shop = testWith(ShopApplication);

describe("#194: a cancelled run is reported as ExecutionStatus.Cancelled", () => {
  shop("aborting the run's signal mid-run resolves cancelled", async ({ app, mockModel }) => {
    const controller = new AbortController();
    mockModel(Buyer).respondWith(() => {
      controller.abort();
      return replyWith("bought");
    });

    const outcome = await execute(
      app,
      Order,
      { text: "buy a lamp" },
      { signal: controller.signal },
    );

    // a cancel is an outcome, not an error (#1341)
    expect(outcome).toMatchObject({ status: ExecutionStatus.Cancelled, pending: [] });
    expect(outcome).not.toBeInstanceOf(AGBossError);
    expect(mockModel(Checker).requests).toHaveLength(0);
  });

  shop("a signal aborted before the run starts resolves the same way", async ({ app }) => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execute(app, Order, { text: "buy a lamp" }, { signal: controller.signal }),
    ).resolves.toMatchObject({ status: ExecutionStatus.Cancelled });
  });
});
