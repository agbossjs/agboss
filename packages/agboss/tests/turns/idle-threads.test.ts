import { hours, usd } from "../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { removeExpired, type RetentionSources } from "../../src/infrastructure/retention-sweep.js";
import { TurnStoreRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { createSqliteTurnStore, type NewTurn, type TurnStatus } from "../../src/turns/index.js";
import { checkThreadOwner } from "../../src/run/thread.js";
import { answerOf } from "../../src/testing/contracts/pause-answer-log.cases.js";

/** #1303c: the sweep of idle threads, on the SQLite Turn store and through the retention sweep. */

const WORKFLOW = "desk-workflow";
const ended = (): Promise<boolean> => Promise.resolve(true);

/** A store on a clock the test moves. */
const setup = () => {
  let at = new Date("2026-01-05T09:00:00.000Z");
  const store = createSqliteTurnStore(":memory:", () => at);
  const records = new TurnStoreRecordRepository(store);
  return {
    store,
    records,
    now: () => at,
    advance: (ms: number) => {
      at = new Date(at.getTime() + ms);
    },
  };
};

const turn = (threadId: string, runId: string, status: TurnStatus = "answered"): NewTurn => ({
  runId,
  threadId,
  tenantId: "default",
  workflow: WORKFLOW,
  task: "task",
  replyWith: "reply",
  status,
  stopReason: "",
  route: [],
  steps: [],
  costUsd: usd(0.01),
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: null,
  configHash: null,
});

const cutoffs = (now: Date, ttl = hours(1)): ReadonlyMap<string, Date> =>
  new Map([[WORKFLOW, new Date(now.getTime() - ttl)]]);

describe("#1303c: deleteIdleThreads", () => {
  it("removes an idle, ended thread with everything it owns, and counts it", async () => {
    const { store, now, advance } = setup();
    const thread = await store.createThread({
      workflow: WORKFLOW,
      tenantId: "default",
      ownerId: "dana",
    });
    const first = await store.append(turn(thread, "run-1"));
    await store.saveScore(first.id, "judge", 1);
    await store.addSummary({
      tenantId: "default",
      threadId: thread,
      workflow: WORKFLOW,
      memory: "desk-memory",
      fromTurnId: first.id,
      toTurnId: first.id,
      turns: 1,
      text: "s",
      costUsd: usd(0),
    });
    await store.appendPauseAnswer({
      tenantId: "default",
      rootExecutionId: "run-1",
      stepKey: "k",
      askedAt: "2026-01-05T09:00:00.000Z",
      record: "{}",
    });
    advance(hours(2));

    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(1);

    // an owned thread stays as a tombstone: its owner is kept, nothing else of it
    expect(await store.threadOwner(WORKFLOW, "default", thread)).toEqual({ owner: "dana" });
    expect(await store.lastTurns("default", thread, 5)).toEqual([]);
    expect(await store.summaryCount("default", thread, "desk-memory")).toBe(0);
    expect(await store.pauseAnswersOf("default", "run-1")).toEqual([]);
    expect(await store.meanScore([first.id])).toBeNull();
    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(0);
  });

  it("an ownerless thread goes whole", async () => {
    const { store, now, advance } = setup();
    const thread = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await store.append(turn(thread, "run-1"));
    advance(hours(2));

    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(1);

    expect(await store.hasThread(WORKFLOW, "default", thread)).toBe(false);
  });

  it("a swept thread leaves nothing another owner can claim; the same owner restarts clean", async () => {
    const { store, now, advance } = setup();
    const thread = await store.createThread({
      workflow: WORKFLOW,
      tenantId: "default",
      ownerId: "dana",
      threadId: "case-7",
    });
    await store.append(turn(thread, "run-1"));
    advance(hours(2));
    await store.deleteIdleThreads(cutoffs(now()), ended);

    // another owner asks for the id: it stays dana's, whatever a store still holds under it
    await store.createThread({
      workflow: WORKFLOW,
      tenantId: "default",
      ownerId: "mallory",
      threadId: "case-7",
    });
    expect(await store.threadOwner(WORKFLOW, "default", "case-7")).toEqual({ owner: "dana" });
    expect(await store.lastTurns("default", "case-7", 10)).toEqual([]);
    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(0);
    const asMallory = { tenantId: "default", threadId: "case-7", ownerId: "mallory" };
    await expect(checkThreadOwner(store, WORKFLOW, asMallory)).rejects.toThrow();
    await expect(
      checkThreadOwner(store, WORKFLOW, { ...asMallory, ownerId: "dana" }),
    ).resolves.toBeUndefined();

    // the same owner restarts: empty, then a live thread again until it idles anew
    await store.createThread({
      workflow: WORKFLOW,
      tenantId: "default",
      ownerId: "dana",
      threadId: "case-7",
    });
    expect(await store.lastTurns("default", "case-7", 10)).toEqual([]);
    await store.append(turn("case-7", "run-2"));
    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(0);
    advance(hours(2));
    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(1);
  });

  it("keeps a live thread's turns: running, paused, queued, or a tree not ended", async () => {
    const { store, now, advance } = setup();
    const live: string[] = [];
    for (const status of ["running", "paused", "queued"] as const) {
      const thread = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await store.append(turn(thread, `run-${status}`, status));
      live.push(thread);
    }
    const open = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await store.append(turn(open, "run-open"));
    advance(hours(48));
    const asked: string[] = [];

    const none = await store.deleteIdleThreads(cutoffs(now()), (tree) => {
      asked.push(tree.rootExecutionId);
      return Promise.resolve(false);
    });
    const one = await store.deleteIdleThreads(cutoffs(now()), ended);

    expect(none).toBe(0);
    expect(asked).toContain("run-open");
    expect(one).toBe(1);
    for (const thread of live) expect(await store.lastTurns("default", thread, 5)).toHaveLength(1);
    expect(await store.hasThread(WORKFLOW, "default", open)).toBe(false);
  });

  it("counts the ttl from the last activity: a Turn appended or completed since keeps the thread", async () => {
    const { store, now, advance } = setup();
    const written = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await store.append(turn(written, "run-1"));
    const completed = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    const slow = await store.append(turn(completed, "run-2", "paused"));
    const guarded = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    const cas = await store.append(turn(guarded, "run-3", "paused"));
    const quiet = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await store.append(turn(quiet, "run-4"));
    advance(hours(2));
    await store.append(turn(written, "run-5"));
    const outcome = {
      replyWith: "done",
      status: "answered",
      stopReason: "",
      route: [],
      steps: [],
      costUsd: usd(0),
    } as const;
    await store.complete(slow.id, outcome);
    expect(await store.completeIfStatus(cas.id, "running", outcome)).toBe(false);
    expect(await store.completeIfStatus(cas.id, "paused", outcome)).toBe(true);

    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(1);

    for (const thread of [written, completed, guarded])
      expect(await store.hasThread(WORKFLOW, "default", thread)).toBe(true);
    expect(await store.hasThread(WORKFLOW, "default", quiet)).toBe(false);
  });

  it("a failed compare-and-set is no activity", async () => {
    const { store, now, advance } = setup();
    const thread = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    const done = await store.append(turn(thread, "run-1"));
    advance(hours(2));
    const outcome = { ...turn(thread, "run-1"), status: "answered" } as const;

    expect(await store.completeIfStatus(done.id, "paused", outcome)).toBe(false);

    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(1);
  });

  it("uses each workflow's own cutoff and every tenant's threads of it", async () => {
    const { store, now, advance } = setup();
    const desk = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await store.append(turn(desk, "run-1"));
    const acme = await store.createThread({ workflow: WORKFLOW, tenantId: "acme" });
    await store.append({ ...turn(acme, "run-1"), tenantId: "acme" });
    const other = await store.createThread({ workflow: "other", tenantId: "default" });
    await store.append({ ...turn(other, "run-2"), workflow: "other" });
    advance(hours(2));

    expect(await store.deleteIdleThreads(new Map(), ended)).toBe(0);
    expect(await store.deleteIdleThreads(cutoffs(now()), ended)).toBe(2);

    expect(await store.hasThread("other", "default", other)).toBe(true);
  });

  it("keeps a thread a Turn was appended to while the trees were asked about", async () => {
    const { store, now, advance } = setup();
    const thread = await store.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await store.append(turn(thread, "run-1"));
    advance(hours(2));

    const removed = await store.deleteIdleThreads(cutoffs(now()), async () => {
      await store.append(turn(thread, "run-2", "running"));
      return true;
    });

    expect(removed).toBe(0);
    expect(await store.lastTurns("default", thread, 5)).toHaveLength(2);
  });

  it("a pause answer of a swept run goes with it (the contract's answer shape)", async () => {
    const { records, store, now, advance } = setup();
    const thread = await records.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await records.append(turn(thread, "run-1"));
    await records.savePauseAnswer("default", "run-1", answerOf("dana", true));
    advance(hours(2));

    expect(await records.deleteIdleThreads(cutoffs(now()), ended)).toBe(1);

    expect(await records.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1")).toEqual(
      [],
    );
    store.close();
  });
});

describe("#1303c: the retention sweep removes idle threads by each workflow's ttl", () => {
  const sourcesOn = (
    records: TurnStoreRecordRepository,
    now: () => Date,
    ttls: ReadonlyMap<string, number>,
  ): RetentionSources =>
    ({
      clock: { now },
      pauses: { setAsideStaleNoticesBefore: () => Promise.resolve([]) },
      pauseRecordRetention: undefined,
      threadRecords: records,
      threadTtls: ttls,
    }) as never;

  it("reports the count; a thread of a live tree stays, a ttl of Forever is not listed", async () => {
    const { records, now, advance } = setup();
    const ended1 = await records.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await records.append(turn(ended1, "run-1"));
    const live = await records.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await records.append(turn(live, "run-2", "running"));
    const forever = await records.createThread({
      workflow: "forever-workflow",
      tenantId: "default",
    });
    await records.append({ ...turn(forever, "run-3"), workflow: "forever-workflow" });
    advance(hours(3));
    const sources = sourcesOn(records, now, new Map([[WORKFLOW, hours(1)]]));

    const swept = await removeExpired(sources, () => undefined);

    expect(swept.find((row) => row.what === "the idle memory threads")).toEqual({
      what: "the idle memory threads",
      removed: 1,
    });
    expect(await records.hasThread(WORKFLOW, "default", ended1)).toBe(false);
    expect(await records.hasThread(WORKFLOW, "default", live)).toBe(true);
    expect(await records.hasThread("forever-workflow", "default", forever)).toBe(true);
  });

  it("the ttl is counted on the Clock: a thread younger than its ttl stays", async () => {
    const { records, now, advance } = setup();
    const thread = await records.createThread({ workflow: WORKFLOW, tenantId: "default" });
    await records.append(turn(thread, "run-1"));
    advance(hours(1) - 1);

    await removeExpired(sourcesOn(records, now, new Map([[WORKFLOW, hours(1)]])), () => undefined);

    expect(await records.hasThread(WORKFLOW, "default", thread)).toBe(true);
  });
});
