/**
 * #265 AC7 / AC11, #267 S35 / AC3 / AC12: `PausedExecutionRepository` — one paused execution per
 * thread, kept with the versions it paused under; one pause record per step key, whatever the
 * number of tries; exactly one of two concurrent `Pending → Resolved` transitions of one pause
 * succeeds, with its decision, also from two instances; `markSent` never overwrites a resolved
 * pause. One suite, run against the in-memory default and `SqlitePausedExecutionRepository` (two
 * instances on one file).
 */
import { describe, expect, it } from "vitest";
import type { PausedExecution } from "../../src/app/paused-runs.js";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  PauseAnswerer,
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../src/index.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { buildCostReport } from "../../src/finops/usage.js";
import { sharedInMemory, storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<PausedExecutionRepository>({
  inMemory: (seam) => sharedInMemory(seam, "paused", () => new InMemoryPausedExecutionRepository()),
  sqlite: ({ clock, connection }) => new SqlitePausedExecutionRepository(connection(), clock),
});

/** A paused run as the app stores it (`budgetUsd: Infinity` — a run without a cost limit). */
const pausedRunOf = (threadId: string, runId = "run-1"): PausedExecution => ({
  run: {
    runId,
    threadId,
    tenantId: "default",
    ternId: "tern-1",
    status: ExecutionStatus.Paused,
    start: "order-workflow-start",
    startInput: { text: "charge" },
    budgetUsd: Number.POSITIVE_INFINITY,
    path: ["start", "clerk"],
    cost: buildCostReport([]),
    data: { scope: {}, outdatedValues: [], lastError: null },
    pending: [],
  },
  workflowVersion: "1.0.0",
  configHash: "hash",
});

/** A new pause of a step, as the pause step makes it. */
const pauseOf = (pauseId: string, stepKey = "run-1:clerk-agent:1:call-1"): PauseRecord => ({
  pauseId,
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey,
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  agent: "clerk-agent",
  channel: "refund-approval-channel",
  answeredBy: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

/** What a channel decided at once. */
const decidedAnswer = { decision: { approved: true }, answerer: undefined };

/** The moments the tests resolve pauses at. */
const NINE = new Date("2026-01-05T09:00:00.000Z");
const TEN = new Date("2026-01-05T10:00:00.000Z");

describe.each(kinds)("#265 AC7: paused executions by thread ($name)", ({ twoInstances }) => {
  it("a saved pause is found on the other instance as written, its versions with it", async () => {
    const { first, second } = twoInstances();
    const paused = pausedRunOf("thread-1");

    await first.save(paused);

    expect(await second.findByTenantIdAndThreadId("default", "thread-1")).toEqual(paused);
    expect(await second.findByTenantIdAndThreadId("default", "thread-2")).toBeUndefined();
  });

  it("a later pause of the thread replaces the earlier one; a delete forgets it", async () => {
    const { first, second } = twoInstances();
    await first.save(pausedRunOf("thread-1", "run-1"));
    await first.save(pausedRunOf("thread-1", "run-2"));

    const latest = await second.findByTenantIdAndThreadId("default", "thread-1");
    await second.deleteByTenantIdAndThreadId("default", "thread-1");

    expect(latest?.run.runId).toBe("run-2");
    expect(await first.findByTenantIdAndThreadId("default", "thread-1")).toBeUndefined();
  });
});

describe.each(kinds)("#267 S35 / AC3: one pause per step key ($name)", ({ twoInstances }) => {
  it("a step's second try finds the first pause, with its id — on the other instance too", async () => {
    const { first, second } = twoInstances();

    const made = await first.findOrCreateByStepKey(pauseOf("pause-a"));
    const again = await second.findOrCreateByStepKey(pauseOf("pause-b"));

    expect(made).toEqual(pauseOf("pause-a"));
    expect(again.pauseId).toBe("pause-a");
    expect(await second.findByTenantIdAndPauseId("default", "pause-b")).toBeUndefined();
  });

  it("a pause is found by its tenant and id only; the tree lists its pauses", async () => {
    const { first, second } = twoInstances();
    await first.findOrCreateByStepKey(pauseOf("pause-a"));
    await first.findOrCreateByStepKey(pauseOf("pause-b", "run-1:clerk-agent:1:call-2"));

    const tree = await second.findAllByTenantIdAndRootExecutionId("default", "run-1");

    expect(tree.map((pause) => pause.pauseId).sort()).toEqual(["pause-a", "pause-b"]);
    expect(await second.findByTenantIdAndPauseId("acme", "pause-a")).toBeUndefined();
    expect(await second.findAllByTenantIdAndRootExecutionId("acme", "run-1")).toEqual([]);
  });

  it("#337: its branch keys are kept as written, on the other instance too", async () => {
    const { first, second } = twoInstances();
    const branchKeys = ["run-1:refund-one-workflow:1:0", "child-1:clerk-agent:1"];

    await first.findOrCreateByStepKey({ ...pauseOf("pause-a"), branchKeys });

    expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toEqual({
      ...pauseOf("pause-a"),
      branchKeys,
    });
  });

  it("marking it sent changes a pending pause only", async () => {
    const { first, second } = twoInstances();
    await first.findOrCreateByStepKey(pauseOf("pause-a"));

    expect(await second.markSentByTenantIdAndPauseId("default", "pause-a")).toBe(true);
    expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.isSent).toBe(true);
    await second.decideByTenantIdAndPauseId("default", "pause-a", decidedAnswer, NINE);
    expect(await first.markSentByTenantIdAndPauseId("default", "pause-a")).toBe(false);
  });
});

describe.each(kinds)(
  "#265 AC11 / #267 AC12: a pause goes from Pending to Resolved once ($name)",
  ({ twoInstances }) => {
    it("of two concurrent transitions of one pause on two instances exactly one succeeds, with its decision", async () => {
      const { first, second } = twoInstances();
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      const yes = { decision: { approved: true }, answerer: "manager-17" };
      const no = { decision: { approved: false }, answerer: "manager-18" };

      const [one, other] = await Promise.all([
        first.resolveByTenantIdAndPauseId("default", "pause-a", yes, NINE),
        second.resolveByTenantIdAndPauseId("default", "pause-a", no, NINE),
      ]);

      const replied = {
        status: PauseStatus.Resolved,
        answer: yes,
        resolution: PauseResolution.Replied,
        resolvedAt: NINE.toISOString(),
      };
      expect(one).toMatchObject(replied);
      expect(other).toBeUndefined();
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject(replied);
      expect(
        await first.resolveByTenantIdAndPauseId("default", "no-such-pause", yes, NINE),
      ).toBeUndefined();
    });

    it("a fast reply before `send` returns: markSent does not overwrite the resolved pause", async () => {
      const { first, second } = twoInstances();
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      const answer = { decision: { approved: true }, answerer: undefined };

      await second.resolveByTenantIdAndPauseId("default", "pause-a", answer, NINE);
      const marked = await first.markSentByTenantIdAndPauseId("default", "pause-a");

      expect(marked).toBe(false);
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Resolved,
        isSent: false,
        answer: { decision: { approved: true } },
      });
    });

    it("a cancelled pause takes no answer and cannot be cancelled again", async () => {
      const { first, second } = twoInstances();
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      const withdrawn = PauseResolution.Withdrawn;
      expect(await first.cancelByTenantIdAndPauseId("default", "pause-a", withdrawn, NINE)).toBe(
        true,
      );
      const cancelled = PauseResolution.Cancelled;
      expect(await second.cancelByTenantIdAndPauseId("default", "pause-a", cancelled, TEN)).toBe(
        false,
      );
      const answer = { decision: { approved: true }, answerer: "manager-17" };
      expect(
        await second.resolveByTenantIdAndPauseId("default", "pause-a", answer, TEN),
      ).toBeUndefined();
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Withdrawn,
        resolvedAt: NINE.toISOString(),
      });
    });
  },
);

describe.each(kinds)(
  "#267 S107: how each pause was resolved, and how long it is kept ($name)",
  ({ twoInstances }) => {
    it("a pause its channel decided at once is Taken, Decided, with the channel's decision", async () => {
      const { first, second } = twoInstances();
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      expect(
        await second.decideByTenantIdAndPauseId("default", "pause-a", decidedAnswer, NINE),
      ).toBe(true);
      expect(await first.decideByTenantIdAndPauseId("default", "pause-a", decidedAnswer, TEN)).toBe(
        false,
      );

      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
        status: PauseStatus.Taken,
        resolution: PauseResolution.Decided,
        answer: { decision: { approved: true } },
        resolvedAt: NINE.toISOString(),
      });
    });

    it("an answer keeps what reading its reply cost; the tree lists its pauses in the order asked", async () => {
      const { first, second } = twoInstances();
      const usage = {
        caller: "reply-interpreter:refund-reply-interpreter",
        model: "test/interpreter",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        costSource: "api" as const,
      };
      await first.findOrCreateByStepKey(pauseOf("pause-b", "run-1:clerk-agent:1:call-2"));
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      const answer = { decision: { approved: true }, answerer: "manager-17", usage: [usage] };

      await second.resolveByTenantIdAndPauseId("default", "pause-a", answer, NINE);

      const tree = await first.findAllByTenantIdAndRootExecutionId("default", "run-1");
      expect(tree.map((pause) => pause.pauseId)).toEqual(["pause-b", "pause-a"]);
      expect(tree[1]?.answer).toEqual(answer);
    });

    it("deleteResolvedBefore removes Taken and Cancelled records resolved before the cutoff only", async () => {
      const { first, second } = twoInstances();
      const keys = ["a", "b", "c", "d", "e"].map((id) => `run-1:clerk-agent:1:call-${id}`);
      for (const [index, key] of keys.entries())
        await first.findOrCreateByStepKey(pauseOf(`pause-${String(index)}`, key));
      const answer = { decision: { approved: true }, answerer: "manager-17" };
      await first.decideByTenantIdAndPauseId("default", "pause-0", decidedAnswer, NINE);
      await first.cancelByTenantIdAndPauseId("default", "pause-1", PauseResolution.Cancelled, NINE);
      await first.resolveByTenantIdAndPauseId("default", "pause-2", answer, NINE);
      await first.decideByTenantIdAndPauseId("default", "pause-3", decidedAnswer, TEN);

      await second.deleteResolvedBefore(new Date("2026-01-05T09:30:00.000Z"));

      const left = await first.findAllByTenantIdAndRootExecutionId("default", "run-1");
      // the resolved one not taken yet and the pending one stay, whatever their age
      expect(left.map((pause) => pause.pauseId)).toEqual(["pause-2", "pause-3", "pause-4"]);
    });
  },
);
