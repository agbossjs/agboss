/**
 * #941 on its own (`pause-expiry.ts`, `tree-expiry.ts`): which pauses are due; what each expiry
 * records — no handler for a pause a run deadline or a quorum bound, `fail()` for a channel with
 * none, a refused compare-and-set counts nothing; a cancel request stops the expiring; the pass an
 * expiry starts marks the root `running` first and only when a pause is due, and never expires a
 * pause twice in one drain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { duePausesOf, expirePauses } from "../../src/app/pause-expiry.js";
import { expiredPassOf } from "../../src/app/tree-expiry.js";
import {
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
} from "../../src/infrastructure/pause-record.js";

const mocks = vi.hoisted(() => ({
  isCancelRequested: vi.fn(),
  recoveryPassOf: vi.fn(),
  treeResumeNow: vi.fn(),
}));
vi.mock("../../src/app/cancel-requests.js", () => ({ isCancelRequested: mocks.isCancelRequested }));
vi.mock("../../src/app/recovery-pass.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/recovery-pass.js")>()),
  recoveryPassOf: mocks.recoveryPassOf,
}));
vi.mock("../../src/app/tree-resume.js", () => ({ treeResumeNow: mocks.treeResumeNow }));

const NOW = new Date("2026-01-01T12:00:00.000Z");
const pause = (id: string, overrides: Record<string, unknown> = {}) => ({
  pauseId: id,
  tenantId: "acme",
  rootExecutionId: "root-1",
  workflow: "desk-workflow",
  channel: "refund-channel",
  status: PauseStatus.Pending,
  answerer: "channel",
  step: "desk-clerk-agent",
  kind: "question",
  ask: {},
  askedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T11:00:00.000Z",
  expiryBound: PauseExpiryBound.Pause,
  ...overrides,
});

function partsOf(records: readonly unknown[], channel?: { onPauseExpired?: () => unknown }) {
  const expire = vi.fn((_t: string, id: string, _e: unknown, _at: Date, _r: unknown) =>
    Promise.resolve({ ...pause(id), resolution: PauseResolution.Expired }),
  );
  const savePauseAnswer = vi.fn(() => Promise.resolve());
  const warn = vi.fn();
  const sender = { send: () => Promise.resolve(), ...channel };
  const parts = {
    deps: {
      config: { name: "desk-workflow" },
      graph: { nodes: new Map(), type: Error },
      channelOf: () => ({ sender }),
      tools: () => ({ timeout: 30_000 }),
      pause: {
        pauses: {
          findAllByTenantIdAndRootExecutionId: vi.fn(() => Promise.resolve(records)),
          expireByTenantIdAndPauseId: expire,
        },
        answers: { savePauseAnswer },
      },
      log: { warn },
    },
    trees: {},
    clock: { now: () => NOW },
  };
  return { parts: parts as never, expire, savePauseAnswer, warn };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCancelRequested.mockResolvedValue(false);
});

describe("#941: the pauses due now", () => {
  it("only the pending ones whose deadline is at or before now", async () => {
    const { parts } = partsOf([
      pause("due"),
      pause("exactly", { expiresAt: NOW.toISOString() }),
      pause("later", { expiresAt: "2026-01-01T12:00:00.001Z" }),
      pause("none", { expiresAt: undefined }),
      pause("answered", { status: PauseStatus.Resolved }),
    ]);

    const found = await duePausesOf(parts, { tenantId: "acme", runId: "root-1" }, NOW);

    expect(found.map((one) => one.pauseId)).toEqual(["due", "exactly"]);
  });
});

describe("#941: expiring a tree's due pauses", () => {
  it("a channel with no handler: fail() — an empty expiry, recorded once, logged, its notices written", async () => {
    const { parts, expire, savePauseAnswer } = partsOf([]);

    const closed = await expirePauses(parts, [pause("p-1") as never]);

    expect(closed).toBe(1);
    expect(expire).toHaveBeenCalledWith("acme", "p-1", {}, NOW, expect.anything());
    expect(savePauseAnswer).toHaveBeenCalledOnce();
  });

  it("a pause bound by the run's deadline or a quorum's: no handler is asked", async () => {
    const onPauseExpired = vi.fn();
    const { parts, expire } = partsOf([], { onPauseExpired });

    await expirePauses(parts, [
      pause("run", { expiryBound: PauseExpiryBound.RunDeadline }) as never,
      pause("quorum", { expiryBound: PauseExpiryBound.Quorum }) as never,
    ]);

    expect(onPauseExpired).not.toHaveBeenCalled();
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it("a channel a deploy removed: its pause expires as fail(), never stuck", async () => {
    const { parts, expire } = partsOf([]);
    Reflect.set(Object(Reflect.get(parts, "deps")), "channelOf", () => {
      throw new Error("Unknown channel: refund-channel");
    });

    const closed = await expirePauses(parts, [pause("p-1") as never]);

    expect(closed).toBe(1);
    expect(expire).toHaveBeenCalledWith("acme", "p-1", {}, NOW, expect.anything());
  });

  it("a refused compare-and-set (the pause closed meanwhile) records and logs nothing", async () => {
    const { parts, expire, savePauseAnswer } = partsOf([]);
    expire.mockResolvedValueOnce(undefined as never);

    const closed = await expirePauses(parts, [pause("p-1") as never]);

    expect(closed).toBe(0);
    expect(savePauseAnswer).not.toHaveBeenCalled();
  });

  it("a cancel request found first: no decision is asked or recorded (a cancel beats an expiry)", async () => {
    const onPauseExpired = vi.fn();
    const { parts, expire } = partsOf([], { onPauseExpired });
    mocks.isCancelRequested.mockResolvedValue(true);

    const closed = await expirePauses(parts, [pause("p-1") as never, pause("p-2") as never]);

    expect(closed).toBe(0);
    expect(onPauseExpired).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it("a cancel request that arrives while the decision is made drops it", async () => {
    const { parts, expire } = partsOf([]);
    mocks.isCancelRequested.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const closed = await expirePauses(parts, [pause("p-1") as never]);

    expect(closed).toBe(0);
    expect(expire).not.toHaveBeenCalled();
  });
});

describe("#941: the pass an expiry starts (expiredPassOf)", () => {
  const stored = { run: { runId: "root-1", turnId: "turn-1", path: [], cost: { totalUsd: 0 } } };
  const state = { runId: "root-1", threadId: "t-1", tenantId: "acme", startedVersion: "1" };

  function movesOf(records: readonly unknown[]) {
    const { parts, expire } = partsOf(records);
    const completeIfStatus = vi.fn(() => Promise.resolve(true));
    const wired = {
      ...(parts as object),
      paused: { find: vi.fn(() => Promise.resolve(stored)) },
    } as never as Parameters<typeof expiredPassOf>[0];
    Reflect.get(Object(Reflect.get(wired, "deps")), "turns");
    Reflect.set(Object(Reflect.get(wired, "deps")), "turns", { completeIfStatus });
    return { parts: wired, completeIfStatus, expire };
  }

  it("no pause due: nothing is marked, nothing asked, no pass", async () => {
    const { parts, completeIfStatus, expire } = movesOf([
      pause("later", { expiresAt: "2027-01-01T00:00:00.000Z" }),
    ]);

    const planned = await expiredPassOf(parts, state, {}, { tried: new Set() });

    expect(planned).toBeUndefined();
    expect(completeIfStatus).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it("a due pause: the root is marked running first (paused → running), then it is expired, then the pass that takes it", async () => {
    const { parts, completeIfStatus, expire } = movesOf([pause("p-1")]);
    const order: string[] = [];
    completeIfStatus.mockImplementation(() => {
      order.push("mark");
      return Promise.resolve(true);
    });
    expire.mockImplementation(() => {
      order.push("expire");
      return Promise.resolve({ ...pause("p-1"), resolution: PauseResolution.Expired });
    });
    mocks.treeResumeNow.mockResolvedValueOnce({ values: {}, pauseIds: ["p-1"] });

    const planned = await expiredPassOf(parts, state, {}, { tried: new Set() });

    expect(order).toEqual(["mark", "expire"]);
    expect(completeIfStatus).toHaveBeenCalledWith("turn-1", "paused", expect.anything());
    expect(planned?.resume).toEqual({ values: {}, pauseIds: ["p-1"] });
  });

  it("nothing to take after the expiry (a store refused): the tree is rested again as a recovery rests it", async () => {
    const { parts } = movesOf([pause("p-1")]);
    mocks.treeResumeNow.mockResolvedValueOnce(undefined);
    mocks.recoveryPassOf.mockResolvedValueOnce({ pass: "rest" });

    const planned = await expiredPassOf(parts, state, {}, { tried: new Set() });

    expect(planned).toEqual({ pass: "rest" });
    expect(mocks.recoveryPassOf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ turnId: "turn-1", runId: "root-1" }),
      expect.anything(),
    );
  });

  it("a pause the drain already tried to expire is not tried again: no loop on a store that refuses", async () => {
    const { parts, expire } = movesOf([pause("p-1")]);

    const planned = await expiredPassOf(parts, state, {}, { tried: new Set(["p-1"]) });

    expect(planned).toBeUndefined();
    expect(expire).not.toHaveBeenCalled();
  });
});
