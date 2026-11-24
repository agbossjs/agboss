/**
 * #1341c: a channel's decision that arrives while the root is paused from outside is recorded and
 * not resumed — the pause is `Resolved`, the run stays paused, the decision is not lost — and once the
 * freeze is lifted by `app.unpause` the run resumes exactly once with that decision.
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseStatus } from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExtensionApplication,
  ownerFlow,
  resetTold,
  told,
} from "../flow/fixtures/pause-extension.fixture.js";

const extension = testWith(ExtensionApplication);
const approve = { approved: true };

beforeEach(() => {
  resetTold();
});

describe("#1341c: a channel decision on a root paused from outside", () => {
  extension(
    "is recorded, never resumed, and resumes once after the unpause",
    async ({ app, clock }) => {
      const paused = await execute(
        app,
        ownerFlow.start,
        { orderId: "o-1" },
        { threadId: "frozen", ownerId: "alice" },
      );
      const store = app.resolve(PausedExecutionRepository);
      const [pause] = (
        await store.findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 10)
      ).pauses;
      await app.pause("frozen", {
        mode: InterruptMode.Immediate,
        reason: "freeze",
        ownerId: "alice",
      });
      told.ownerDecides = approve;

      await app.reassignPause(
        { pauseId: pause?.pauseId ?? "", assignee: "deputy-3" },
        { ownerId: "alice" },
      );
      await clock.advance(seconds(40));

      // answered and kept, not taken: the run did not move
      expect(told.recorded).toEqual([]);
      const resolved = await store.findPageByTenantId(
        "default",
        { statuses: [PauseStatus.Resolved] },
        10,
      );
      expect(resolved.pauses).toHaveLength(1);

      // the unpause lifts the freeze and takes the decision that was recorded meanwhile, at once
      const lifted = await app.unpause("frozen", { ownerId: "alice" });
      await clock.advance(seconds(40));
      await until(() => told.recorded.length === 1);
      expect(lifted.status).not.toBe(ExecutionStatus.Paused);
      await clock.advance(seconds(40));

      expect(told.recorded).toEqual(["o-1: approved"]);
    },
  );
});
