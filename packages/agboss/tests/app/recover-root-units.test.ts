/**
 * #633 (recovery shard) — one `running` root continued by the sweep (`recover-root.ts`) and its
 * pass (`recovery-pass.ts`) on their own: a root that is ending ends on any config, a root of
 * another config is left to a compatible instance unless the policy resumes it, the thread's owner
 * goes with the recovery, each problem is logged as what it is, a pass takes its recorded answers
 * only when they are this run's, and a root's calls are counted in and out.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { problemOf, recoverRootOf } from "../../src/app/recover-root.js";
import { recordEndedOf, recoveryPassOf, RootCalls } from "../../src/app/recovery-pass.js";
import type { TreeMoves } from "../../src/app/tree-moves.js";
import { IncompatibleResumeError, type IncompatibleResume } from "../../src/run/resume-guard.js";
import type { InterruptedRun } from "../../src/run/continue-agent.js";
import type { Tern } from "../../src/terns/index.js";

const mocks = vi.hoisted(() => ({ treeResumeNow: vi.fn() }));

vi.mock("../../src/app/tree-origin.js", () => ({
  withTreeOrigin: (_deps: unknown, state: unknown) => Promise.resolve(state),
}));
vi.mock("../../src/app/tree-resume.js", () => ({
  treeResumeNow: mocks.treeResumeNow,
  // #853: no lost passes to carry — the call as it is
  callWithLostPasses: (_parts: unknown, _state: unknown, call: unknown) => Promise.resolve(call),
}));

const recordOf = (overrides: Partial<Tern> = {}): Tern =>
  ({
    id: "tern-1",
    runId: "root-1",
    threadId: "thread-1",
    tenantId: "acme",
    configVersion: "1.0.0",
    configHash: "hash-1",
    ...overrides,
  }) as Tern;

function partsOf(owner?: string) {
  const moves = {
    endIfEnding: vi.fn((_interrupted: InterruptedRun) => Promise.resolve(false)),
    recovered: vi.fn((_interrupted: InterruptedRun, _call: unknown) => Promise.resolve(undefined)),
  };
  const deps: AppDeps = {
    config: { name: "desk-workflow", version: "2.0.0" },
    terns: {
      threadOwner: vi.fn(() => Promise.resolve(owner === undefined ? undefined : { owner })),
    },
  } as never;
  return { moves, deps };
}

const signal = new AbortController().signal;

describe("#633: recoverRootOf", () => {
  it("a record of no run (before #238): nothing asked", async () => {
    const { moves, deps } = partsOf();
    const recover = recoverRootOf({
      deps,
      moves: moves as never,
      current: { workflowVersion: "1.0.0", configHash: "hash-1" },
      policy: undefined,
    });

    await recover(recordOf({ runId: null }), signal);

    expect(moves.endIfEnding).not.toHaveBeenCalled();
  });

  it("the root as its record names it, on the version it started on — else this one's", async () => {
    const { moves, deps } = partsOf();
    const recover = recoverRootOf({
      deps,
      moves: moves as never,
      current: { workflowVersion: "", configHash: "" },
      policy: () => "resume",
    });

    await recover(recordOf({ configVersion: "0.9.0" }), signal);
    await recover(recordOf({ configVersion: null }), signal);

    expect(moves.endIfEnding.mock.calls.map(([interrupted]) => interrupted)).toEqual([
      {
        runId: "root-1",
        threadId: "thread-1",
        tenantId: "acme",
        ternId: "tern-1",
        startedVersion: "0.9.0",
      },
      {
        runId: "root-1",
        threadId: "thread-1",
        tenantId: "acme",
        ternId: "tern-1",
        startedVersion: "2.0.0",
      },
    ]);
  });

  it("an ending root: ended, on any config — no check, no recovery", async () => {
    const { moves, deps } = partsOf();
    moves.endIfEnding.mockResolvedValue(true);
    const recover = recoverRootOf({
      deps,
      moves: moves as never,
      current: { workflowVersion: "2.0.0", configHash: "another-hash" },
      policy: undefined,
    });

    await recover(recordOf(), signal);

    expect(moves.recovered).not.toHaveBeenCalled();
  });

  it("a record of before #78 (no version, no hash) on an instance that knows none: compatible", async () => {
    const { moves, deps } = partsOf();
    const recover = recoverRootOf({
      deps,
      moves: moves as never,
      current: { workflowVersion: "", configHash: "" },
      policy: undefined,
    });

    await recover(recordOf({ configVersion: null, configHash: null }), signal);

    expect(moves.recovered).toHaveBeenCalledOnce();
  });

  it("another config: the policy sees what the root started on; without it the root is left", async () => {
    const { moves, deps } = partsOf();
    const seen: IncompatibleResume[] = [];
    const current = { workflowVersion: "2.0.0", configHash: "hash-2" };
    const resuming = recoverRootOf({
      deps,
      moves: moves as never,
      current,
      policy: (resume) => {
        seen.push(resume);
        return "resume";
      },
    });
    const leaving = recoverRootOf({
      deps,
      moves: moves as never,
      current,
      policy: undefined,
    });

    await resuming(recordOf(), signal);
    await resuming(recordOf({ configVersion: null }), signal);
    await expect(leaving(recordOf(), signal)).rejects.toThrow(IncompatibleResumeError);

    expect(seen.map((resume) => resume.paused)).toEqual([
      { workflowVersion: "1.0.0", configHash: "hash-1" },
      { workflowVersion: "", configHash: "hash-1" },
    ]);
    expect(moves.recovered).toHaveBeenCalledTimes(2);
  });

  it("recovered under the sweep's signal, with the thread's owner — none for an unowned thread", async () => {
    const owned = partsOf("alice");
    const unowned = partsOf();
    const current = { workflowVersion: "1.0.0", configHash: "hash-1" };
    for (const { moves, deps } of [owned, unowned])
      await recoverRootOf({
        deps,
        moves: moves as never,
        current,
        policy: undefined,
      })(recordOf(), signal);

    expect(owned.moves.recovered.mock.calls[0]?.[1]).toEqual({ signal, ownerId: "alice" });
    expect(unowned.moves.recovered.mock.calls[0]?.[1]).toEqual({ signal, ownerId: undefined });
  });
});

describe("#633: problemOf", () => {
  const incompatible = new IncompatibleResumeError({
    threadId: "thread-1",
    executionId: "root-1",
    paused: { workflowVersion: "1.0.0", configHash: "hash-1" },
    current: { workflowVersion: "2.0.0", configHash: "hash-2" },
  });

  it("another config: at risk, left to a compatible instance", () => {
    expect(problemOf(recordOf(), incompatible)).toEqual({
      code: "recovery.incompatible",
      text: `execution root-1 is left to an instance of a compatible version: ${incompatible.message}`,
      isBroken: false,
      executionId: "root-1",
      tenantId: "acme",
    });
  });

  it("any other error: broken, its message; a thrown value by its text; a record of no run by its id", () => {
    expect(problemOf(recordOf(), new Error("store down"))).toEqual({
      code: "recovery.failed",
      text: "recovery of execution root-1 failed: store down",
      isBroken: true,
      executionId: "root-1",
      tenantId: "acme",
    });
    expect(problemOf(recordOf({ runId: null }), "gone")).toMatchObject({
      text: "recovery of execution tern-1 failed: gone",
      executionId: "tern-1",
    });
  });
});

describe("#633: recoveryPassOf", () => {
  const interrupted = {
    runId: "root-1",
    threadId: "thread-1",
    tenantId: "acme",
    ternId: "tern-1",
  } as InterruptedRun;
  const call = { signal } as never;
  const resume = { values: {}, pauseIds: ["pause-1"], taken: [], decisions: [], answerers: [] };

  function passParts(status: string, stored: unknown) {
    const find = vi.fn(() => Promise.resolve(stored));
    const deps: AppDeps = {
      terns: { byIds: () => Promise.resolve([{ status }]) },
    } as never;
    return { find, parts: { deps, paused: { find } } as never };
  }

  it("its record no longer runs: no pass, nothing read", async () => {
    const { parts, find } = passParts("finished", { run: { runId: "root-1" } });

    expect(await recoveryPassOf(parts, interrupted, call)).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it("the answers recorded for this run's pauses: taken by the pass", async () => {
    mocks.treeResumeNow.mockResolvedValue(resume);
    const { parts } = passParts("running", { run: { runId: "root-1" } });

    expect((await recoveryPassOf(parts, interrupted, call))?.resume).toBe(resume);
  });

  it("answers but no stored run, another run's, or no answers: from the last checkpoint", async () => {
    const cases = [
      [resume, undefined],
      [resume, { run: { runId: "another-run" } }],
      [undefined, { run: { runId: "root-1" } }],
    ] as const;
    for (const [answers, stored] of cases) {
      mocks.treeResumeNow.mockResolvedValue(answers);
      const { parts } = passParts("running", stored);

      const pass = await recoveryPassOf(parts, interrupted, call);

      expect(pass).toBeDefined();
      expect(pass).not.toHaveProperty("resume");
    }
  });

  it("recordEndedOf: a record gone counts as ended, a running one does not", async () => {
    const terns = (records: readonly { status: string }[]) => ({
      byIds: () => Promise.resolve(records as never),
    });

    expect(await recordEndedOf(terns([]), "tern-1")()).toBe(true);
    expect(await recordEndedOf(terns([{ status: "running" }]), "tern-1")()).toBe(false);
  });
});

describe("#633: RootCalls", () => {
  it("counts each call in and out: a root is moved until its last call left", () => {
    const calls = new RootCalls();
    const first = calls.enter("root-1");
    const second = calls.enter("root-1");

    const before = calls.has("root-1");
    first();
    const afterOne = calls.has("root-1");
    second();

    expect([before, afterOne, calls.has("root-1"), calls.has("root-2")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("a call counted out twice never leaves a count behind", () => {
    const calls = new RootCalls();
    const leave = calls.enter("root-1");

    leave();
    leave();

    expect(calls.has("root-1")).toBe(false);
  });
});
