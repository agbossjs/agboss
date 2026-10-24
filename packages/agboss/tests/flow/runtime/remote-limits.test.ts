import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { totalCost, type UsageRecord } from "../../../src/finops/usage.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { replyWith, TestConcurrency, testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds, usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { ItemResultDto } from "./fixtures/fan-out.workflow.js";
import {
  closeGate,
  release,
  RemoteChecksWorkflowFinish,
  remoteLog,
  resetRemoteLog,
} from "./fixtures/remote-children.workflow.js";
import {
  RemoteCappedWorkflowStart,
  RemoteLimitsApplication,
  RemoteSpendCheckedWorkflowFinish,
  RemoteSpenderAgent,
  RemoteSpendWorkflowStart,
} from "./fixtures/remote-limits.workflow.js";

/**
 * #333 PR 3 (AC3) — the limits of a tree hold whichever instance runs its children: the tree's
 * `maxConcurrentExecutions` is one count over the instances (its slots leases in the shared
 * `RateLimitRepository`), and a child's spend is written to the tree's counters where it runs —
 * counted once, never again by its parent.
 */

const instances = testWith(RemoteLimitsApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
});
const single = testWith(RemoteLimitsApplication);

beforeEach(resetRemoteLog);
afterEach(() => {
  vi.restoreAllMocks();
});

const first = (apps: readonly TestApp[]): TestApp => {
  const [app] = apps;
  if (app === undefined) throw new Error("the test runs no instance");
  return app;
};

const items = (...names: readonly string[]) =>
  names.map((name) => ({ name, delay: 0, outcome: "ok" }));

describe("#333 PR 3: maxConcurrentExecutions over the instances", () => {
  instances(
    "six children on two instances, a cap of 2: two at work at once, then all six",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      closeGate();
      const progress = { isSettled: false };
      const call = execute(
        first(apps),
        RemoteCappedWorkflowStart,
        items("a", "b", "c", "d", "e", "f"),
      );
      const settle = (): void => {
        progress.isSettled = true;
      };
      void call.then(settle, settle);
      let atOnce: number;
      try {
        await vi.waitFor(() => {
          expect(remoteLog.waiting).toBe(2);
        });
        // a few looks of the waiting steps: still two at work
        for (let look = 0; look < 3; look += 1) await clock.advance(seconds(1));
        atOnce = remoteLog.waiting;
      } finally {
        release();
      }
      for (let look = 0; look < 30 && !progress.isSettled; look += 1)
        await clock.advance(seconds(1));
      const result = await call;

      expect(atOnce).toBe(2);
      expect(result).toFinishWith(RemoteChecksWorkflowFinish, { text: "a, b, c, d, e, f" });
      expect(remoteLog.readings).toHaveLength(6);
    },
  );
});

describe("#333 PR 3: a child's spend on any instance", () => {
  single(
    "written to the tree's counters where the child runs, before it ends — and never again",
    async ({ app, mockLlm }) => {
      const saveAll = vi.spyOn(InMemoryCostLedgerRepository.prototype, "saveAll");
      const written = (): readonly UsageRecord[] =>
        saveAll.mock.calls.flatMap(([, records]) => records);
      mockLlm(RemoteSpenderAgent).thenReturn(
        replyWith(ItemResultDto, { name: "a" }, { cost: usd(0.01) }),
      );
      closeGate();
      const call = execute(app, RemoteSpendWorkflowStart, { name: "a", delay: 0, outcome: "ok" });
      let whileRunning: number;
      try {
        await vi.waitFor(() => {
          expect(remoteLog.waiting).toBe(1);
        });
        whileRunning = totalCost(written());
      } finally {
        release();
      }

      const result = await call;

      expect(whileRunning).toBeCloseTo(0.01);
      expect(result).toFinishWith(RemoteSpendCheckedWorkflowFinish, { text: "a" });
      expect(result.spend.totalUsd).toBeCloseTo(0.01);
      expect(totalCost(written())).toBeCloseTo(0.01);
    },
  );
});
