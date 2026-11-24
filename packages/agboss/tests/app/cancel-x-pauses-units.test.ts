/**
 * #1366 (shard `cancel-x-pauses`) on the stores alone: the pauses a launch withdraws (`withdrawn-pauses.ts`) —
 * only the pending ones under the branches named, each closed once with its notices, its log row and its
 * tally —, how a root's ended record says its tree ended (`endOfRecord`), and the pause step's answer
 * (`pause.ts`): a withdrawn or expired pause is no answer, a resolved one is marked taken before the step acts.
 */
import { describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { newRunContext } from "../../src/core/run-context.js";
import { closeTreePauses, endOfRecord } from "../../src/app/tree-end-pauses.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { RandomIdGenerator } from "../../src/infrastructure/clock.js";
import {
  NO_RECIPIENTS,
  PauseResolution,
  PauseStatus,
} from "../../src/infrastructure/pause-record.js";
import {
  DecisionWithdrawal,
  isWithdrawn,
  launchPausesOf,
  withdrawBranchPauses,
  withdrawLaunchPauses,
  withdrawPause,
} from "../../src/flow/runtime/launch/withdrawn-pauses.js";
import { PauseWithdrawnError } from "../../src/flow/runtime/pause.js";
import {
  APPROVED_BY_MANAGER,
  pauseOf,
  RECIPIENTS,
} from "../../src/testing/contracts/paused-execution-data.js";
import { VirtualClock } from "../../src/testing/clock.js";

const AT = new Date("2026-01-05T11:00:00.000Z");

function storesOf() {
  const pauses = new InMemoryPausedExecutionRepository();
  const answers = new InMemoryExecutionRecordRepository(
    new VirtualClock(),
    new RandomIdGenerator(),
  );
  const delivered = vi.fn();
  const closed = vi.fn();
  const notices = {
    recipientsOf: () => RECIPIENTS,
    delivered,
    tally: { closed, opened: vi.fn(), answerNotTaken: vi.fn() },
  };
  return { pauses, answers, delivered, closed, stores: { pauses, answers, notices } as never };
}

const logOf = (answers: InMemoryExecutionRecordRepository) =>
  answers.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1");

describe("#1366: closing a pending pause without an answer", () => {
  it("a pending pause is cancelled with the resolution, its notices looked for at once, its tally told, its close logged", async () => {
    const { pauses, answers, stores, delivered, closed } = storesOf();
    const pause = await pauses.findOrCreateByStepKey(pauseOf("p-1"));

    expect(
      await withdrawPause(stores, pause, { resolution: PauseResolution.Withdrawn, at: AT }),
    ).toBe(true);

    expect(await pauses.findByTenantIdAndPauseId("default", "p-1")).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Withdrawn,
    });
    expect(delivered).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(await logOf(answers)).toMatchObject([{ resolution: PauseResolution.Withdrawn }]);
  });

  it("a pause that is no longer pending: false, nothing looked for, told or logged", async () => {
    const { pauses, answers, stores, delivered, closed } = storesOf();
    const pause = await pauses.findOrCreateByStepKey(pauseOf("p-1"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-1",
      APPROVED_BY_MANAGER,
      AT,
      NO_RECIPIENTS,
    );

    expect(
      await withdrawPause(stores, pause, { resolution: PauseResolution.Withdrawn, at: AT }),
    ).toBe(false);

    expect(delivered).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(await logOf(answers)).toEqual([]);
  });

  it("what the store recorded is what is logged — a close it recorded as Expired; one it names no resolution for is the asked one", async () => {
    const pause = pauseOf("p-1");
    for (const [recorded, logged] of [
      [PauseResolution.Expired, PauseResolution.Expired],
      [undefined, PauseResolution.Withdrawn],
    ] as const) {
      const savePauseAnswer = vi.fn(() => Promise.resolve());
      const stores = {
        pauses: {
          cancelByTenantIdAndPauseId: () => Promise.resolve({ ...pause, resolution: recorded }),
        },
        answers: { savePauseAnswer },
      } as never;

      await withdrawPause(stores, pause, { resolution: PauseResolution.Withdrawn, at: AT });

      expect(savePauseAnswer).toHaveBeenCalledWith(
        "default",
        "run-1",
        expect.objectContaining({ resolution: logged }),
      );
    }
  });

  it("the cancel is asked for the pause's tenant and id, the resolution, the time and the notices' recipients", async () => {
    const pause = pauseOf("p-1");
    const cancel = vi.fn(() => Promise.resolve(undefined));
    const stores = {
      pauses: { cancelByTenantIdAndPauseId: cancel },
      answers: { savePauseAnswer: vi.fn() },
      notices: { recipientsOf: () => RECIPIENTS, delivered: vi.fn() },
    } as never;

    await withdrawPause(stores, pause, { resolution: PauseResolution.Cancelled, at: AT });

    expect(cancel).toHaveBeenCalledWith(
      "default",
      "p-1",
      PauseResolution.Cancelled,
      AT,
      RECIPIENTS,
    );
  });
});

describe("#1366: a launch's pauses", () => {
  const stateOf = (runId: string) =>
    ({ runId, contexts: { tenant: { tenantId: "acme" } } }) as never;

  it("without the application's pause stores: none", () => {
    expect(launchPausesOf(undefined, stateOf("exec-1"), undefined)).toBeUndefined();
  });

  it("an execution of the tree's root: its own id is the root's; the clock is the run's", () => {
    const { stores } = storesOf();
    const clock = new VirtualClock(AT);
    const config = { configurable: { run: newRunContext({ runId: "exec-1" }), clock } };

    const site = launchPausesOf(stores, stateOf("exec-1"), config);

    expect(site).toMatchObject({
      stores,
      tenantId: "acme",
      rootExecutionId: "exec-1",
      launchExecutionId: "exec-1",
    });
    expect(site?.now().toISOString()).toBe(AT.toISOString());
  });

  it("inside a child the records belong to the tree's root", () => {
    const { stores } = storesOf();
    const parent = { execution: { executionId: "root-1" } } as never;
    const run = { ...newRunContext({ runId: "child-1" }), tree: { parent } };

    const site = launchPausesOf(stores, stateOf("child-1"), { configurable: { run } });

    expect(site).toMatchObject({ rootExecutionId: "root-1", launchExecutionId: "child-1" });
  });

  const ticket = (nodeId: string, visitNumber: number, itemIndex?: number) =>
    ({ index: 0, node: nodeId, nodeId, copyNumber: 1, visitNumber, itemIndex }) as never;

  async function launchOf() {
    const { pauses, answers, stores, closed } = storesOf();
    const site = {
      stores,
      tenantId: "default",
      rootExecutionId: "run-1",
      launchExecutionId: "run-1",
      now: () => AT,
    };
    return { pauses, answers, closed, site };
  }

  it("only the pending pauses that wait under a branch named are withdrawn, as `Withdrawn`, with the launch's clock", async () => {
    const { pauses, answers, site } = await launchOf();
    await pauses.findOrCreateByStepKey({
      ...pauseOf("under"),
      nodeId: "branch-agent",
      visitNumber: 1,
      branchKeys: ["run-1:branch-agent:1"],
    });
    await pauses.findOrCreateByStepKey({
      ...pauseOf("other", "k2"),
      branchKeys: ["run-1:another-agent:1"],
    });
    await pauses.findOrCreateByStepKey({
      ...pauseOf("answered", "k3"),
      branchKeys: ["run-1:branch-agent:1"],
    });
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "answered",
      APPROVED_BY_MANAGER,
      AT,
      NO_RECIPIENTS,
    );

    const cancel = vi.spyOn(pauses, "cancelByTenantIdAndPauseId");

    await withdrawBranchPauses(site, [ticket("branch-agent", 1)]);

    // only the pending pause under the branch is asked to close
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0]?.[1]).toBe("under");
    expect(await pauses.findByTenantIdAndPauseId("default", "under")).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Withdrawn,
    });
    expect(await pauses.findByTenantIdAndPauseId("default", "other")).toMatchObject({
      status: PauseStatus.Pending,
    });
    expect(await pauses.findByTenantIdAndPauseId("default", "answered")).toMatchObject({
      status: PauseStatus.Resolved,
    });
    expect(await logOf(answers)).toHaveLength(1);
  });

  it("a pause stored before branch keys existed has its own step's only; a per-item branch has its item in the key", async () => {
    const { pauses, site } = await launchOf();
    await pauses.findOrCreateByStepKey({
      ...pauseOf("old"),
      nodeId: "branch-agent",
      visitNumber: 1,
    });
    await pauses.findOrCreateByStepKey({
      ...pauseOf("item", "k2"),
      nodeId: "item-agent",
      visitNumber: 2,
      itemIndex: 3,
    });
    await pauses.findOrCreateByStepKey({
      ...pauseOf("other-item", "k3"),
      nodeId: "item-agent",
      visitNumber: 2,
      itemIndex: 4,
    });

    await withdrawBranchPauses(site, [ticket("branch-agent", 1), ticket("item-agent", 2, 3)]);

    expect(await pauses.findByTenantIdAndPauseId("default", "old")).toMatchObject({
      status: PauseStatus.Cancelled,
    });
    expect(await pauses.findByTenantIdAndPauseId("default", "item")).toMatchObject({
      status: PauseStatus.Cancelled,
    });
    expect(await pauses.findByTenantIdAndPauseId("default", "other-item")).toMatchObject({
      status: PauseStatus.Pending,
    });
  });

  it("a pause that waits under several launching steps is withdrawn by any one of them", async () => {
    const { pauses, site } = await launchOf();
    await pauses.findOrCreateByStepKey({
      ...pauseOf("deep"),
      nodeId: "deep-agent",
      visitNumber: 1,
      branchKeys: ["run-1:outer-branch:1", "run-1:deep-agent:1"],
    });

    await withdrawBranchPauses(site, [ticket("outer-branch", 1)]);

    expect(await pauses.findByTenantIdAndPauseId("default", "deep")).toMatchObject({
      status: PauseStatus.Cancelled,
    });
  });

  it("no branch: the store is not even read", async () => {
    const { pauses, site } = await launchOf();
    const read = vi.spyOn(pauses, "findAllByTenantIdAndRootExecutionId");

    await withdrawBranchPauses(site, []);

    expect(read).not.toHaveBeenCalled();
  });

  it("withdrawLaunchPauses withdraws where the launch has stores and does nothing without them", async () => {
    const { pauses, site } = await launchOf();
    await pauses.findOrCreateByStepKey({
      ...pauseOf("p-1"),
      nodeId: "branch-agent",
      visitNumber: 1,
    });

    await withdrawLaunchPauses(undefined, [ticket("branch-agent", 1)]);
    expect(await pauses.findByTenantIdAndPauseId("default", "p-1")).toMatchObject({
      status: PauseStatus.Pending,
    });
    await withdrawLaunchPauses(site, [ticket("branch-agent", 1)]);
    expect(await pauses.findByTenantIdAndPauseId("default", "p-1")).toMatchObject({
      status: PauseStatus.Cancelled,
    });
  });

  it("a withdrawn pause is found in the error, or in its cause chain; any other error is not", () => {
    const withdrawn = new PauseWithdrawnError({ message: "withdrawn" });

    expect(isWithdrawn(withdrawn)).toBe(true);
    expect(isWithdrawn(new Error("a", { cause: new Error("b", { cause: withdrawn }) }))).toBe(true);
    expect(isWithdrawn(new Error("a", { cause: "text" }))).toBe(false);
    expect(isWithdrawn("text")).toBe(false);
    expect(isWithdrawn(undefined)).toBe(false);
  });
});

describe("#1366: the withdrawal of a decided quorum", () => {
  const deferred = () => {
    let done: () => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      done = resolve;
      fail = reject;
    });
    return { promise, done, fail };
  };
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("started once, however often it is asked", () => {
    const withdraw = vi.fn(() => Promise.resolve());
    const withdrawal = new DecisionWithdrawal(withdraw);

    withdrawal.start();
    withdrawal.start();

    expect(withdraw).toHaveBeenCalledOnce();
  });

  it("started while a branch runs only; never when no branch of the pass runs", async () => {
    const withdraw = vi.fn(() => Promise.resolve());
    const withdrawal = new DecisionWithdrawal(withdraw);

    withdrawal.startWhileRunning();
    expect(withdraw).not.toHaveBeenCalled();

    const branch = deferred();
    const running = withdrawal.during(() => branch.promise);
    withdrawal.startWhileRunning();
    expect(withdraw).toHaveBeenCalledOnce();
    branch.done();
    await running;

    // the branch ended: the count is back to none
    const later = new DecisionWithdrawal(vi.fn(() => Promise.resolve()));
    await later.during(() => Promise.resolve());
    later.startWhileRunning();
    expect(later).toBeDefined();
  });

  it("a count that went back to none starts nothing", async () => {
    const withdraw = vi.fn(() => Promise.resolve());
    const withdrawal = new DecisionWithdrawal(withdraw);

    await withdrawal.during(() => Promise.resolve(1));
    withdrawal.startWhileRunning();

    expect(withdraw).not.toHaveBeenCalled();
  });

  it("a branch's run ends only once the withdrawal started is done, and returns its own value", async () => {
    const closing = deferred();
    const withdrawal = new DecisionWithdrawal(() => closing.promise);
    let ended = false;
    const running = withdrawal
      .during(() => Promise.resolve("value"))
      .then((value) => {
        ended = true;
        return value;
      });
    withdrawal.start();

    await turn();
    expect(ended).toBe(false);
    closing.done();
    expect(await running).toBe("value");
  });

  it("the withdrawal's failure is the branch's to fail on, never an unhandled rejection of its own", async () => {
    const closing = deferred();
    const withdrawal = new DecisionWithdrawal(() => closing.promise);
    const running = withdrawal.during(() => Promise.resolve("value"));
    withdrawal.start();
    closing.fail(new Error("the store failed"));

    await expect(running).rejects.toThrow("the store failed");
  });

  it("a branch that throws still waits for the withdrawal, and counts out", async () => {
    const withdraw = vi.fn(() => Promise.resolve());
    const withdrawal = new DecisionWithdrawal(withdraw);

    await expect(withdrawal.during(() => Promise.reject(new Error("failed")))).rejects.toThrow(
      "failed",
    );
    withdrawal.startWhileRunning();

    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe("#1366: how a root's ended record says its tree ended", () => {
  it("a cancel by the record's status (#1341): the cancel of the thread, whatever its reason's text", () => {
    for (const stopReason of ['thread "thread-1" was cancelled', "the run was cancelled", ""]) {
      const end = endOfRecord({ status: "cancelled", stopReason, threadId: "thread-1" });
      expect(end).toBeInstanceOf(ExecutionCancelledError);
      expect(end.message).toBe('thread "thread-1" was cancelled');
    }
  });

  it("any other status is the record's own reason, as a plain error — also a reason that merely says cancelled", () => {
    const end = endOfRecord({
      status: "failed",
      stopReason: "the user cancelled the order",
      threadId: "thread-1",
    });

    expect(end).not.toBeInstanceOf(ExecutionCancelledError);
    expect(end.message).toBe("the user cancelled the order");
    expect(
      endOfRecord({
        status: "failed",
        stopReason: 'thread "thread-2" was cancelled',
        threadId: "thread-1",
      }),
    ).not.toBeInstanceOf(ExecutionCancelledError);
    expect(
      endOfRecord({ status: "failed", stopReason: "the run was cancelled", threadId: "thread-1" }),
    ).not.toBeInstanceOf(ExecutionCancelledError);
  });
});

describe("#1366: a tree's end closes each pause once, by what it is now", () => {
  const SITE = { tenantId: "default", threadId: "thread-1", rootExecutionId: "run-1" };
  const END = { cause: new ExecutionCancelledError() };

  /** Fake stores that answer each call as told and say which were made. */
  function fakeStores(pausesNow: unknown[], overrides: Record<string, unknown> = {}) {
    const delivered = vi.fn();
    const answerNotTaken = vi.fn();
    const closed = vi.fn();
    const stores = {
      pauses: {
        deleteByTenantIdAndThreadIdAndRunId: vi.fn(() => Promise.resolve()),
        findAllByTenantIdAndRootExecutionId: vi.fn(() => Promise.resolve(pausesNow)),
        findByTenantIdAndPauseId: vi.fn(() => Promise.resolve(undefined)),
        cancelByTenantIdAndPauseId: vi.fn((_t: string, _id: string, resolution: unknown) =>
          Promise.resolve({ ...(pausesNow[0] as object), resolution }),
        ),
        closeUntakenByTenantIdAndPauseId: vi.fn(() =>
          Promise.resolve({ ...(pausesNow[0] as object), resolution: PauseResolution.Cancelled }),
        ),
        ...overrides,
      },
      answers: {
        savePauseAnswer: vi.fn(() => Promise.resolve()),
        markPauseAnswerNotTaken: vi.fn(() => Promise.resolve()),
      },
      notices: {
        recipientsOf: () => RECIPIENTS,
        delivered,
        tally: { closed, answerNotTaken, opened: vi.fn() },
      },
    };
    return { stores: stores as never, raw: stores, delivered, answerNotTaken, closed };
  }

  const pending = (id = "p-1") => ({ ...pauseOf(id), status: PauseStatus.Pending });
  const resolved = (id = "p-1") => ({
    ...pauseOf(id),
    status: PauseStatus.Resolved,
    answer: APPROVED_BY_MANAGER,
  });

  it("the tree's paused run is removed first, then the pauses are read and closed", async () => {
    const order: string[] = [];
    const { stores, raw } = fakeStores([pending()]);
    raw.pauses.deleteByTenantIdAndThreadIdAndRunId.mockImplementation(() => {
      order.push("delete");
      return Promise.resolve();
    });
    raw.pauses.findAllByTenantIdAndRootExecutionId.mockImplementation(() => {
      order.push("find");
      return Promise.resolve([pending()]);
    });

    await closeTreePauses({ stores }, SITE, END, AT);

    expect(order).toEqual(["delete", "find"]);
    expect(raw.pauses.deleteByTenantIdAndThreadIdAndRunId).toHaveBeenCalledWith(
      "default",
      "thread-1",
      "run-1",
    );
    expect(raw.pauses.findAllByTenantIdAndRootExecutionId).toHaveBeenCalledWith("default", "run-1");
  });

  it("a pending pause is withdrawn with the end's resolution at the given time; closed, it is not read again", async () => {
    const { stores, raw } = fakeStores([pending()]);

    await closeTreePauses({ stores }, SITE, END, AT);

    expect(raw.pauses.cancelByTenantIdAndPauseId).toHaveBeenCalledWith(
      "default",
      "p-1",
      PauseResolution.Cancelled,
      AT,
      RECIPIENTS,
    );
    expect(raw.pauses.closeUntakenByTenantIdAndPauseId).not.toHaveBeenCalled();
    expect(raw.pauses.findByTenantIdAndPauseId).not.toHaveBeenCalled();
  });

  it("an answer no step consumed is closed not taken: its notices looked for, its tally told, its log row written; not read again", async () => {
    const { stores, raw, delivered, answerNotTaken } = fakeStores([resolved()]);

    await closeTreePauses({ stores }, SITE, { cause: new Error("failed") }, AT);

    expect(raw.pauses.closeUntakenByTenantIdAndPauseId).toHaveBeenCalledWith(
      "default",
      "p-1",
      PauseResolution.TreeEnded,
      AT,
      RECIPIENTS,
    );
    expect(delivered).toHaveBeenCalledOnce();
    expect(answerNotTaken).toHaveBeenCalledOnce();
    expect(raw.answers.markPauseAnswerNotTaken).toHaveBeenCalledOnce();
    expect(raw.pauses.findByTenantIdAndPauseId).not.toHaveBeenCalled();
    expect(raw.pauses.cancelByTenantIdAndPauseId).not.toHaveBeenCalled();
  });

  it.each([PauseStatus.Taken, PauseStatus.Cancelled])(
    "a pause that is %s is left alone: nothing is closed, written or read again",
    async (status) => {
      const { stores, raw, delivered } = fakeStores([{ ...pauseOf("p-1"), status }]);

      await closeTreePauses({ stores }, SITE, END, AT);

      expect(raw.pauses.cancelByTenantIdAndPauseId).not.toHaveBeenCalled();
      expect(raw.pauses.closeUntakenByTenantIdAndPauseId).not.toHaveBeenCalled();
      expect(raw.pauses.findByTenantIdAndPauseId).not.toHaveBeenCalled();
      expect(raw.answers.markPauseAnswerNotTaken).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
    },
  );

  it("a pause that changed under the close (the store refuses it) is read again once, and closed by what it is then", async () => {
    const { stores, raw, delivered } = fakeStores([resolved()], {
      closeUntakenByTenantIdAndPauseId: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ ...pauseOf("p-1"), resolution: PauseResolution.Cancelled }),
      findByTenantIdAndPauseId: vi.fn(() => Promise.resolve(resolved())),
    });

    await closeTreePauses({ stores }, SITE, END, AT);

    expect(raw.pauses.findByTenantIdAndPauseId).toHaveBeenCalledOnce();
    expect(raw.pauses.findByTenantIdAndPauseId).toHaveBeenCalledWith("default", "p-1");
    expect(raw.pauses.closeUntakenByTenantIdAndPauseId).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenCalledOnce();
    expect(raw.answers.markPauseAnswerNotTaken).toHaveBeenCalledOnce();
  });

  it("a refused close of a pause that is gone is the end of it: nothing else is closed", async () => {
    const { stores, raw, delivered } = fakeStores([resolved()], {
      closeUntakenByTenantIdAndPauseId: vi.fn(() => Promise.resolve(undefined)),
      findByTenantIdAndPauseId: vi.fn(() => Promise.resolve(undefined)),
    });

    await closeTreePauses({ stores }, SITE, END, AT);

    expect(raw.pauses.closeUntakenByTenantIdAndPauseId).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
    expect(raw.answers.markPauseAnswerNotTaken).not.toHaveBeenCalled();
  });

  it("a pending pause withdrawn by another meanwhile is read again once: still pending, it is withdrawn then", async () => {
    const { stores, raw } = fakeStores([pending()], {
      cancelByTenantIdAndPauseId: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ ...pauseOf("p-1"), resolution: PauseResolution.Cancelled }),
      findByTenantIdAndPauseId: vi.fn(() => Promise.resolve(pending())),
    });

    await closeTreePauses({ stores }, SITE, END, AT);

    expect(raw.pauses.cancelByTenantIdAndPauseId).toHaveBeenCalledTimes(2);
    expect(raw.pauses.findByTenantIdAndPauseId).toHaveBeenCalledOnce();
  });
});

describe("#1366: a withdrawal's failure", () => {
  it("is raised by the branch that awaits it, never as a rejection nobody handles", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const withdrawal = new DecisionWithdrawal(() => Promise.reject(new Error("the store failed")));

    withdrawal.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", listener);

    expect(unhandled).toEqual([]);
  });
});
