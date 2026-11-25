/**
 * #1328: the `testWith` seams `modelProvider` and `channels` replace the application's own, as a
 * profile's would — the test names its provider and its channels, nothing implicit.
 */
import { describe, expect } from "vitest";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  DeskRefundChannel,
  TargetInbox,
  TargetsApplication,
} from "../channels/pause-targets.fixture.js";
import { PurchaseWorkflowStart } from "../flow/fixtures/questions.fixture.js";
import { EvalDeskModelProvider } from "../flow/fixtures/eval-desk.fixture.js";
import { HistoryDeskApplication } from "../flow/fixtures/execution-history.fixture.js";

const named = testWith(HistoryDeskApplication, { modelProvider: EvalDeskModelProvider });

describe("#1328: TestWithOptions.modelProvider", () => {
  named("the test's provider is the application's: its container creates it", async ({ app }) => {
    await app.ready();

    expect(app.get(EvalDeskModelProvider)).toBeInstanceOf(EvalDeskModelProvider);
  });
});

const asking = { threadId: "purchase-1", ownerId: "alice" };
const keptChannels = testWith(TargetsApplication);
const replacedChannels = testWith(TargetsApplication, { channels: [DeskRefundChannel] });

describe("#1328: TestWithOptions.channels", () => {
  keptChannels(
    "without it the application's own channels ask: the execution pauses",
    async ({ app }) => {
      const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

      expect(paused.pending).toHaveLength(1);
      expect(app.resolve(TargetInbox).asked).toHaveLength(1);
    },
  );

  replacedChannels(
    "the test's channels replace the application's, never merge: the inbox channel is no longer asked",
    async ({ app }) => {
      await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

      expect(app.resolve(TargetInbox).asked).toEqual([]);
    },
  );
});
