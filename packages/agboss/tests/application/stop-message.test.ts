/**
 * #582 (found in the acceptance of #567) — what an execution interrupted by a stop tells the
 * caller. `app.close()` interrupts each running execution when its shutdown timeout ends: it stays
 * `running`, and the next take of its lease continues it. On a lone instance that take is this
 * application's own, once it starts again: the message never says another instance continues it.
 */
import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError } from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  Hold,
  levers,
  OrderWorkflowStart,
  RecoveryApplication,
  resetRecovery,
} from "../infrastructure/fixtures/recovery.workflow.js";

const lone = testWith(RecoveryApplication);

beforeEach(resetRecovery);

describe("#582: an execution interrupted by a stop", () => {
  lone(
    "on a lone instance: the next take of its lease continues it — no other instance as a fact",
    async ({ app, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Hold, { text: "a long job" }));
      const held = new Promise<void>((resolve) => {
        levers.holdStarted = resolve;
      });
      const call = execute(app, OrderWorkflowStart, { text: "hold" });
      const rejected = call.then(
        () => undefined,
        (error: unknown) => error,
      );
      await held;

      const closed = app.close();
      await clock.advance(seconds(25));
      await closed;
      const error = await rejected;

      expect(error).toBeInstanceOf(ApplicationStoppingError);
      const { message } = error as Error;
      expect(message).toMatch(/the execution is interrupted/u);
      expect(message).not.toMatch(/another instance (holds|continues)/u);
      expect(message).toMatch(/the next take of its lease continues it/u);
    },
  );
});
