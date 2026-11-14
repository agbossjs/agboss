/**
 * #928 AC1 — the work after a tree's terminal record (`forgetTree`, `keepExecutionRecord`) runs
 * outside the lease scope: a call there that never answers is an unleased store error at 15 s, never
 * a hand-over.
 */
import { beforeEach, describe, expect } from "vitest";
import { StoreCallTimeoutError } from "../../src/index.js";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { ChargeWorkflowStart, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { outcomeOf } from "./fixtures/bound-stubs.js";
import {
  quiet,
  resetQuiet,
  UnleasedStoreApplication,
} from "./fixtures/unleased-store.application.js";

beforeEach(() => {
  resetLogged();
  resetQuiet();
});

const quietly = testWith(UnleasedStoreApplication);

/** No hand-over happened: no abandoned lease was ever released, no step was handed over. */
const handedOver = (): boolean =>
  logged.some((entry) => entry.code === "execution.lease-abandoned");

describe("#928 AC1: the post-terminal cleanup is unleased", () => {
  beforeEach(() => {
    resetFencedEffect();
    resetRecovery();
  });

  quietly(
    "AC1: forgetTree held for ever is unleased: 15 s each, a store error, no hand-over",
    async ({ app, clock }) => {
      await app.ready();
      quiet.trees = true;
      const failure = outcomeOf(execute(app, ChargeWorkflowStart, { text: "order-3" }));
      await until(() => quiet.treeCalls > 0, "forgetTree reached its store");

      // the tree's end fails once on forgetTree and tries it again (its error path): 15 s each
      await passLive(clock, seconds(15));
      await until(() => quiet.treeCalls > 1, "the end forgot the tree again");
      await passLive(clock, seconds(15));
      const error = await failure;

      expect(error).toBeInstanceOf(StoreCallTimeoutError);
      expect(error).not.toBeInstanceOf(ExecutionLeaseLostError);
      expect(error).toMatchObject({ operation: "deleteAllInTree", timeout: STORE_CALL_BOUND });
      const timeouts = logged.filter((entry) => entry.code === "store.call-timeout");
      expect(timeouts).toHaveLength(2);
      for (const entry of timeouts) expect(entry.message).toMatch(/\(unleased call/u);
      expect(handedOver()).toBe(false);
    },
  );

  quietly(
    "AC1: keepExecutionRecord held for ever is unleased: 15 s, the tree still finishes, no hand-over",
    async ({ app, clock }) => {
      await app.ready();
      quiet.history = true;
      const result = execute(app, ChargeWorkflowStart, { text: "order-4" });
      await until(() => quiet.historyCalls > 0, "the record's save reached its store");

      await passLive(clock, seconds(15));
      await result;

      const timeouts = logged.filter((entry) => entry.code === "store.call-timeout");
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]?.message).toContain("QuietHistory.save");
      expect(timeouts[0]?.message).toMatch(/\(unleased call/u);
      // the keeper says it could not save, and the tree finished: no hand-over
      expect(logged.some((entry) => entry.code === "execution-history.failed")).toBe(true);
      const [end] = await ends(1);
      expect(end?.output).toEqual({ chargeId: "charge-order-4-1" });
      expect(handedOver()).toBe(false);
    },
  );
});
