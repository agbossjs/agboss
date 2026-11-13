/**
 * #939 (#910 I13): `closeTreePauses` on the stores alone — the order of a tree's end and what each
 * pause becomes by its status and its place in the root's checkpoint.
 */
import { describe, expect, it } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import {
  closeTreePauses,
  resolutionOfEnd,
  type TreePauseEnds,
} from "../../src/app/tree-end-pauses.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { RandomIdGenerator } from "../../src/infrastructure/clock.js";
import {
  NO_RECIPIENTS,
  PauseResolution,
  PauseStatus,
} from "../../src/infrastructure/pause-record.js";
import { PauseNoticeKind } from "../../src/infrastructure/pause-notices.js";
import { seconds } from "../../src/units/index.js";
import {
  ALL_KEYS,
  APPROVED_BY_MANAGER,
  pauseOf,
  RECIPIENTS,
  pausedRunOf,
} from "../../src/testing/contracts/paused-execution-data.js";
import { VirtualClock } from "../../src/testing/clock.js";

const AT = new Date("2026-01-05T11:00:00.000Z");
const SITE = { tenantId: "default", threadId: "thread-1", rootExecutionId: "run-1" };

function storesOf(waiting: readonly string[]) {
  const pauses = new InMemoryPausedExecutionRepository();
  const answers = new InMemoryExecutionRecordRepository(
    new VirtualClock(),
    new RandomIdGenerator(),
  );
  const ends: TreePauseEnds = {
    stores: { pauses, answers, withdrawn: undefined },
    waiting: () => Promise.resolve(new Set(waiting)),
  };
  return { pauses, answers, ends };
}

/** A pause answered by a manager (`Resolved`), its answer unlogged. */
async function resolvedPause(pauses: InMemoryPausedExecutionRepository, id: string, key: string) {
  await pauses.findOrCreateByStepKey(pauseOf(id, key));
  await pauses.resolveByTenantIdAndPauseId("default", id, APPROVED_BY_MANAGER, AT, NO_RECIPIENTS);
}

describe("#939: closeTreePauses", () => {
  it("a cancel closes by `Cancelled`, any other end by `TreeEnded` (also through a cause)", () => {
    const cancel = new ExecutionCancelledError();
    expect(resolutionOfEnd({ cause: cancel })).toBe(PauseResolution.Cancelled);
    expect(resolutionOfEnd({ cause: new Error("x", { cause: cancel }) })).toBe(
      PauseResolution.Cancelled,
    );
    expect(resolutionOfEnd({ cause: new Error("failed") })).toBe(PauseResolution.TreeEnded);
  });

  it("a Resolved pause whose step ran (its interrupt is gone from the checkpoint) is Taken, the log untouched", async () => {
    const { pauses, answers, ends } = storesOf([]);
    await resolvedPause(pauses, "p-ran", "run-1:clerk-agent:1:call-1");

    await closeTreePauses(ends, SITE, { cause: new Error("failed after") }, AT);

    expect(await pauses.findByTenantIdAndPauseId("default", "p-ran")).toMatchObject({
      status: PauseStatus.Taken,
      resolution: PauseResolution.Replied,
    });
    expect(await answers.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1")).toEqual(
      [],
    );
  });

  it("a Resolved pause whose interrupt still waits is closed not taken: answer and answerer kept, the log says so", async () => {
    const { pauses, answers, ends } = storesOf(["p-waits"]);
    await resolvedPause(pauses, "p-waits", "run-1:clerk-agent:1:call-1");

    await closeTreePauses(ends, SITE, { cause: new Error("failed before") }, AT);

    expect(await pauses.findByTenantIdAndPauseId("default", "p-waits")).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.TreeEnded,
      answer: APPROVED_BY_MANAGER,
    });
    expect(
      await answers.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1"),
    ).toMatchObject([
      { isTaken: false, resolution: PauseResolution.TreeEnded, answeredBy: "manager-17" },
    ]);
  });

  it.each([
    ["a cancel", new ExecutionCancelledError(), "cancelled"],
    ["a failure", new Error("failed"), "tree-ended"],
  ])(
    "a sent answer closed by %s: its answerNotTaken notice says %s, to the channel and the listeners",
    async (_end, cause, reason) => {
      const { pauses, ends } = storesOf(["p-sent"]);
      await pauses.findOrCreateByStepKey(pauseOf("p-sent", "run-1:clerk-agent:1:call-1"));
      await pauses.markSentByTenantIdAndPauseId("default", "p-sent", RECIPIENTS);
      await pauses.resolveByTenantIdAndPauseId(
        "default",
        "p-sent",
        APPROVED_BY_MANAGER,
        AT,
        RECIPIENTS,
      );

      await closeTreePauses({ ...ends, recipients: () => RECIPIENTS }, SITE, { cause }, AT);

      const claims = await pauses.claimNoticesDue(
        new Date(AT.getTime() + 1),
        10,
        seconds(60),
        ALL_KEYS,
      );
      expect(claims.map((claim) => claim.mailbox.recipient).sort()).toEqual([...ALL_KEYS].sort());
      for (const { mailbox } of claims)
        expect(mailbox.notices.map(({ kind, reason }) => [kind, reason])).toContainEqual([
          PauseNoticeKind.AnswerNotTaken,
          reason,
        ]);
    },
  );

  it("a waiting pause is withdrawn with the end's reason and logged; a Taken one is left alone; a second run changes nothing", async () => {
    const { pauses, answers, ends } = storesOf([]);
    await pauses.findOrCreateByStepKey(pauseOf("p-wait", "run-1:clerk-agent:1:call-1"));
    await pauses.findOrCreateByStepKey(pauseOf("p-done", "run-1:clerk-agent:1:call-2"));
    await pauses.decideByTenantIdAndPauseId("default", "p-done", APPROVED_BY_MANAGER, AT);
    const end = { cause: new ExecutionCancelledError() };

    await closeTreePauses(ends, SITE, end, AT);
    const once = await pauses.findAllByTenantIdAndRootExecutionId("default", "run-1");
    await closeTreePauses(ends, SITE, end, new Date(AT.getTime() + 1000));

    expect(once).toMatchObject([
      { pauseId: "p-wait", status: PauseStatus.Cancelled, resolution: PauseResolution.Cancelled },
      { pauseId: "p-done", status: PauseStatus.Taken, resolution: PauseResolution.Decided },
    ]);
    expect(await pauses.findAllByTenantIdAndRootExecutionId("default", "run-1")).toEqual(once);
    expect(
      await answers.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1"),
    ).toHaveLength(1);
  });

  it("the paused run of this tree goes, the run another turn of the thread paused since stays (#807)", async () => {
    const { pauses, ends } = storesOf([]);
    await pauses.save(pausedRunOf("thread-1", "run-2"));

    await closeTreePauses(ends, SITE, { cause: new Error("done") }, AT);
    expect((await pauses.findByTenantIdAndThreadId("default", "thread-1"))?.run.runId).toBe(
      "run-2",
    );

    await pauses.save(pausedRunOf("thread-1", "run-1"));
    await closeTreePauses(ends, SITE, { cause: new Error("done") }, AT);
    expect(await pauses.findByTenantIdAndThreadId("default", "thread-1")).toBeUndefined();
  });
});
