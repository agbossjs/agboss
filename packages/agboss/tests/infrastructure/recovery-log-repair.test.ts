/**
 * #939 AC5 (#910 I11): the audit log has an entry for every closed pause even if the process died
 * between the close and its log write — the retention writes a missing entry before it removes the
 * record; one already there is left as it is; a backlog over one listing is still logged and removed.
 */
import { describe, expect, it } from "vitest";
import { RandomIdGenerator } from "../../src/infrastructure/clock.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import {
  NO_RECIPIENTS,
  PauseResolution,
  PauseStatus,
} from "../../src/infrastructure/pause-record.js";
import { REPAIR_PAGE } from "../../src/infrastructure/pause-log-repair.js";
import { removeExpired } from "../../src/infrastructure/recovery.js";
import { APPROVED_BY_MANAGER, pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { logPauseAnswer, logPauseNotTaken } from "../../src/infrastructure/pause-answer-log.js";
import { minutes, hours } from "../../src/units/index.js";

const CLOSED = new Date("2026-01-05T09:00:00.000Z");

/** Execution records whose next `count` log writes (answers and not-taken marks) are lost. */
class ForgetfulRecords extends InMemoryExecutionRecordRepository {
  lost = 0;

  override savePauseAnswer(
    ...args: Parameters<InMemoryExecutionRecordRepository["savePauseAnswer"]>
  ) {
    if (this.lost > 0) {
      this.lost -= 1;
      return Promise.resolve();
    }
    return super.savePauseAnswer(...args);
  }

  override markPauseAnswerNotTaken(
    ...args: Parameters<InMemoryExecutionRecordRepository["markPauseAnswerNotTaken"]>
  ) {
    if (this.lost > 0) {
      this.lost -= 1;
      return Promise.resolve();
    }
    return super.markPauseAnswerNotTaken(...args);
  }
}

function setUp() {
  const clock = new VirtualClock(new Date(CLOSED.getTime() + hours(48)));
  const pauses = new InMemoryPausedExecutionRepository();
  const answers = new ForgetfulRecords(clock, new RandomIdGenerator());
  const sources = { clock, pauses, answers, pauseRecordRetention: hours(24) };
  const sweep = () =>
    removeExpired(sources, (text) => {
      throw new Error(text);
    });
  const logOf = () => answers.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1");
  return { pauses, answers, sweep, logOf };
}

describe("#939 AC5: the retention writes a lost log entry before it removes the record", () => {
  it("a close whose log write was lost (the store drops savePauseAnswer once): written, then the record removed", async () => {
    const { pauses, answers, sweep, logOf } = setUp();
    await pauses.findOrCreateByStepKey(pauseOf("p-1", "run-1:clerk-agent:1:call-1"));
    const closed = await pauses.cancelByTenantIdAndPauseId(
      "default",
      "p-1",
      PauseResolution.Withdrawn,
      CLOSED,
      NO_RECIPIENTS,
    );
    answers.lost = 1;
    await logPauseAnswer(answers, closed ?? pauseOf("x"), PauseResolution.Withdrawn);
    expect(await logOf()).toEqual([]);

    await sweep();

    expect(await logOf()).toMatchObject([{ resolution: PauseResolution.Withdrawn }]);
    expect(await pauses.findByTenantIdAndPauseId("default", "p-1")).toBeUndefined();
  });

  it("a taken answer's entry is written with its answer and who gave it", async () => {
    const { pauses, sweep, logOf } = setUp();
    await pauses.findOrCreateByStepKey(pauseOf("p-2", "run-1:clerk-agent:1:call-1"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-2",
      APPROVED_BY_MANAGER,
      CLOSED,
      NO_RECIPIENTS,
    );
    await pauses.markTakenByTenantIdAndPauseId("default", "p-2");

    await sweep();

    expect(await logOf()).toMatchObject([
      {
        resolution: PauseResolution.Replied,
        answeredBy: "manager-17",
        decision: { approved: true },
      },
    ]);
    expect(await pauses.findByTenantIdAndPauseId("default", "p-2")).toBeUndefined();
  });

  it("a not-taken close whose mark was lost: the entry is written not taken, the answer kept", async () => {
    const { pauses, answers, sweep, logOf } = setUp();
    await pauses.findOrCreateByStepKey(pauseOf("p-3", "run-1:clerk-agent:1:call-1"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-3",
      APPROVED_BY_MANAGER,
      CLOSED,
      NO_RECIPIENTS,
    );
    const closed = await pauses.closeUntakenByTenantIdAndPauseId(
      "default",
      "p-3",
      PauseResolution.TreeEnded,
      CLOSED,
      NO_RECIPIENTS,
    );
    answers.lost = 1;
    await logPauseNotTaken(answers, closed ?? pauseOf("x"));

    await sweep();

    expect(await logOf()).toMatchObject([
      { isTaken: false, resolution: PauseResolution.TreeEnded, answeredBy: "manager-17" },
    ]);
  });

  it("a present entry is not rewritten: a not-taken one stays so, once", async () => {
    const { pauses, answers, sweep, logOf } = setUp();
    await pauses.findOrCreateByStepKey(pauseOf("p-4", "run-1:clerk-agent:1:call-1"));
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      "p-4",
      APPROVED_BY_MANAGER,
      CLOSED,
      NO_RECIPIENTS,
    );
    const closed = await pauses.closeUntakenByTenantIdAndPauseId(
      "default",
      "p-4",
      PauseResolution.Cancelled,
      CLOSED,
      NO_RECIPIENTS,
    );
    await logPauseNotTaken(answers, closed ?? pauseOf("x"));
    const before = await logOf();

    await sweep();

    expect(await logOf()).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("a record still inside its retention is neither logged nor removed", async () => {
    const { pauses, answers, sweep, logOf } = setUp();
    await pauses.findOrCreateByStepKey(pauseOf("p-5", "run-1:clerk-agent:1:call-1"));
    await pauses.cancelByTenantIdAndPauseId(
      "default",
      "p-5",
      PauseResolution.Cancelled,
      new Date(),
      NO_RECIPIENTS,
    );
    answers.lost = 0;

    await sweep();

    expect(await logOf()).toEqual([]);
    expect((await pauses.findByTenantIdAndPauseId("default", "p-5"))?.status).toBe(
      PauseStatus.Cancelled,
    );
  });

  it("a backlog over one listing: logged and removed page by page, never a record removed unlogged", async () => {
    const { pauses, sweep, logOf } = setUp();
    const total = REPAIR_PAGE + 5;
    for (let index = 0; index < total; index += 1) {
      const id = `p-b-${String(index)}`;
      await pauses.findOrCreateByStepKey(pauseOf(id, `run-1:clerk-agent:1:call-${String(index)}`));
      await pauses.cancelByTenantIdAndPauseId(
        "default",
        id,
        PauseResolution.Cancelled,
        new Date(CLOSED.getTime() + index * minutes(1)),
        NO_RECIPIENTS,
      );
    }

    // a listing is one page: the first sweep logs and removes it, the next the rest — never a
    // record removed that was not logged
    await sweep();
    const afterFirst = await logOf();
    const left = await pauses.findAllByTenantIdAndRootExecutionId("default", "run-1");
    expect(afterFirst.length).toBeGreaterThanOrEqual(total - left.length);
    expect(left.length).toBeLessThan(total);
    await sweep();

    expect(await logOf()).toHaveLength(total);
    expect(await pauses.findAllByTenantIdAndRootExecutionId("default", "run-1")).toEqual([]);
  });
});
