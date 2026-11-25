import { usd } from "../../src/units/index.js";
/**
 * #1187 (recovery shard) — the wake of a `paused` root beside an answer no pass took
 * (`answered-wake.ts`) and the drain's mark before it takes an answer (`answeredRunOf`,
 * `recovery-pass.ts`), on their own: only a `paused` record, only under the tree's lease (a held
 * lease is its holder's, who takes the answer), only while an answer is left to take — the record
 * marked `running` by compare-and-set from `paused`, the lease given back in every case.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { wakeAnsweredOf } from "../../src/app/answered-wake.js";
import { answeredPassOf } from "../../src/app/recovery-pass.js";
import type { TreeMoveParts } from "../../src/app/tree-move-types.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import type { LeaseTake } from "../../src/app/execution-leases.js";
import type { Turn } from "../../src/turns/index.js";
import { runningOutcome } from "../../src/run/execute.js";

const mocks = vi.hoisted(() => ({ treeResumeNow: vi.fn() }));

vi.mock("../../src/app/tree-resume.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/tree-resume.js")>()),
  treeResumeNow: mocks.treeResumeNow,
}));

const RESUME = { values: {}, pauseIds: ["p-2"], taken: [], decisions: [], actors: [] };

const recordOf = (status: string): Turn => {
  const record: Turn = {
    id: "turn-1",
    runId: "root-1",
    threadId: "thread-1",
    tenantId: "acme",
    status,
    configVersion: "1.0.0",
    route: ["ask"],
    costUsd: usd(0.5),
  } as never;
  return record;
};

/** The stored rest of `root-1`, its record `turn-1`. */
const STORED = {
  run: { runId: "root-1", turnId: "turn-1", path: ["ask"], cost: { totalUsd: usd(0.5) } },
};

function partsOf(
  options: {
    readonly isHeld?: boolean;
    readonly status?: string;
    readonly stored?: unknown;
    readonly isGone?: boolean;
  } = {},
) {
  const takes: LeaseTake[] = [];
  const released = vi.fn(() => Promise.resolve());
  const completeIfStatus = vi.fn(() => Promise.resolve(true));
  const status = options.status ?? ExecutionRecordStatus.Paused;
  const deps: AppDeps = {
    config: { version: "2.0.0" },
    pause: undefined,
    turns: {
      completeIfStatus,
      byIds: () => Promise.resolve(options.isGone === true ? [] : [recordOf(status)]),
    },
  } as never;
  const parts: Pick<TreeMoveParts, "deps" | "paused" | "leases"> = {
    deps,
    paused: { find: () => Promise.resolve("stored" in options ? options.stored : STORED) },
    leases: {
      // not paused from outside (#1341c)
      pauseOf: () => Promise.resolve({}),
      tryHold: (_tree: unknown, take: LeaseTake) => {
        takes.push(take);
        return Promise.resolve(options.isHeld === true ? undefined : { release: released });
      },
    },
  } as never;
  return { parts, takes, released, completeIfStatus };
}

const ROOT_STATE = { runId: "root-1" } as never;
const call = { signal: undefined } as never;

describe("#1187: the drain marks its record running before it takes an answer after its rest", () => {
  it("after a rest, an answer to take: the record is marked running from paused (compare-and-set), with the rest's path and cost", async () => {
    mocks.treeResumeNow.mockResolvedValueOnce(RESUME);
    const { parts, completeIfStatus } = partsOf();

    const answered = await answeredPassOf(
      parts as never,
      { runId: "root-1" } as never,
      call,
      undefined,
      true,
    );

    expect(answered?.resume).toBe(RESUME);
    expect(completeIfStatus).toHaveBeenCalledWith(
      "turn-1",
      ExecutionRecordStatus.Paused,
      runningOutcome(["ask"], usd(0.5)),
    );
  });

  it("a resume's or an expiry's take (not after a rest) marks nothing: its caller marked it before the lease", async () => {
    mocks.treeResumeNow.mockResolvedValueOnce(RESUME);
    const { parts, completeIfStatus } = partsOf();

    expect(await answeredPassOf(parts as never, { runId: "root-1" } as never, call)).toBeDefined();
    expect(completeIfStatus).not.toHaveBeenCalled();
  });

  it("no answer to take, or a rest of another run: nothing taken, nothing marked", async () => {
    mocks.treeResumeNow.mockResolvedValueOnce(undefined);
    const none = partsOf();
    const other = partsOf();
    mocks.treeResumeNow.mockResolvedValueOnce(RESUME);
    const otherRun: typeof other.parts = {
      ...other.parts,
      paused: { find: () => Promise.resolve({ run: { ...STORED.run, runId: "root-2" } }) },
    } as never;

    expect(
      await answeredPassOf(none.parts as never, ROOT_STATE, call, undefined, true),
    ).toBeUndefined();
    expect(
      await answeredPassOf(otherRun as never, ROOT_STATE, call, undefined, true),
    ).toBeUndefined();
    expect(none.completeIfStatus).not.toHaveBeenCalled();
    expect(other.completeIfStatus).not.toHaveBeenCalled();
  });
});

describe("#1187: the wake of a paused root beside an untaken answer", () => {
  it("under the lease, with an answer left: marked running from the record (its route and cost), the lease given back", async () => {
    mocks.treeResumeNow.mockResolvedValueOnce(RESUME);
    const { parts, released, completeIfStatus, takes } = partsOf();

    expect(await wakeAnsweredOf(parts)(recordOf(ExecutionRecordStatus.Paused))).toBe(true);
    expect(completeIfStatus).toHaveBeenCalledWith(
      "turn-1",
      ExecutionRecordStatus.Paused,
      runningOutcome(["ask"], usd(0.5)),
    );
    expect(released).toHaveBeenCalledOnce();
    expect(takes[0]?.isTakeover).toBe(true);
  });

  it("trap 1: no paused run kept (the holder died between its rest and keeping it) — the answer still wakes the root", async () => {
    mocks.treeResumeNow.mockResolvedValueOnce(RESUME);
    const { parts, completeIfStatus } = partsOf({ stored: undefined });

    expect(await wakeAnsweredOf(parts)(recordOf(ExecutionRecordStatus.Paused))).toBe(true);
    expect(completeIfStatus).toHaveBeenCalledOnce();
  });

  it("a record of no run (written before #238) is left alone: no lease asked for", async () => {
    const { parts, takes } = partsOf();
    const runless = { ...recordOf(ExecutionRecordStatus.Paused), runId: null };

    expect(await wakeAnsweredOf(parts)(runless)).toBe(false);
    expect(takes).toEqual([]);
  });

  it("the tree is read as its record started it: the record's version, else this instance's", async () => {
    const { parts } = partsOf();
    const unversioned = { ...recordOf(ExecutionRecordStatus.Paused), configVersion: null };
    mocks.treeResumeNow.mockClear();
    mocks.treeResumeNow.mockResolvedValue(undefined);

    await wakeAnsweredOf(parts)(recordOf(ExecutionRecordStatus.Paused));
    await wakeAnsweredOf(parts)(unversioned);

    const versions = mocks.treeResumeNow.mock.calls.map(
      (args: unknown[]) => (args[1] as { readonly startedVersion: string }).startedVersion,
    );
    expect(versions).toEqual(["1.0.0", "2.0.0"]);
    mocks.treeResumeNow.mockReset();
  });

  it("a record that is not paused is left alone: no lease asked for", async () => {
    const { parts, takes, completeIfStatus } = partsOf();

    for (const status of ["running", "answered", "failed"])
      expect(await wakeAnsweredOf(parts)(recordOf(status))).toBe(false);
    expect(takes).toEqual([]);
    expect(completeIfStatus).not.toHaveBeenCalled();
  });

  it("a lease held elsewhere is its holder's: nothing read, nothing marked", async () => {
    mocks.treeResumeNow.mockClear();
    const { parts, completeIfStatus } = partsOf({ isHeld: true });

    expect(await wakeAnsweredOf(parts)(recordOf(ExecutionRecordStatus.Paused))).toBe(false);
    expect(mocks.treeResumeNow).not.toHaveBeenCalled();
    expect(completeIfStatus).not.toHaveBeenCalled();
  });

  it("trap 2: a resolved pause no waiting interrupt takes (a withdrawn branch's, the tree resting at a later pending one), or an answer a pass took — nothing marked, the lease given back", async () => {
    mocks.treeResumeNow.mockResolvedValueOnce(undefined);
    const { parts, completeIfStatus, released } = partsOf();

    expect(await wakeAnsweredOf(parts)(recordOf(ExecutionRecordStatus.Paused))).toBe(false);
    expect(completeIfStatus).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
  });

  it("the take is over once the record left paused: a holder that moved it meanwhile keeps it", async () => {
    const paused = partsOf();
    const running = partsOf({ status: "running" });
    mocks.treeResumeNow.mockResolvedValue(undefined);

    await wakeAnsweredOf(paused.parts)(recordOf(ExecutionRecordStatus.Paused));
    await wakeAnsweredOf(running.parts)(recordOf(ExecutionRecordStatus.Paused));

    const gone = partsOf({ isGone: true });
    await wakeAnsweredOf(gone.parts)(recordOf(ExecutionRecordStatus.Paused));

    expect(await paused.takes[0]?.isOver?.()).toBe(false);
    expect(await running.takes[0]?.isOver?.()).toBe(true);
    // a record gone (its tree's end removed it) is over too
    expect(await gone.takes[0]?.isOver?.()).toBe(true);
    mocks.treeResumeNow.mockReset();
  });
});
