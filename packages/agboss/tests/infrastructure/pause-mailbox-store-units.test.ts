/**
 * #1356 (pauses shards) — the mailboxes of the built-in pause stores, in memory and on SQLite, on their own: which
 * mailboxes a claim takes and in what order, when a claim is over, what an acknowledgement, a renewal, a retry and
 * a set-aside change and for whom, which pause keeps a live mailbox, and what a stale look takes (#935, #1131).
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { PauseNoticeKind } from "../../src/infrastructure/pause-notices.js";
import type { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const kinds: readonly (readonly [string, () => PausedExecutionRepository])[] = [
  ["in memory", () => new InMemoryPausedExecutionRepository()],
  [
    "SQLite",
    () =>
      new SqlitePausedExecutionRepository(
        connectionTo(temporarySqlitePath()),
        new VirtualClock(new Date(0)),
      ),
  ],
];

/** The channel is told, and no listener: one mailbox a pause, written at the time the pause was answered. */
const RECIPIENTS: { channel: string; listeners: string[] } = { channel: "refund", listeners: [] };
/** A listener hears of the pause as well: a second mailbox, its `opened` written at the store's own time. */
const BOTH = { channel: "refund", listeners: ["metrics"] };
const CHANNEL = "channel:refund";
const LISTENER = "listener:metrics";
const at = (second: number): Date => new Date(second * 1000);

/** A sent pause answered at `answeredAt`: each of its recipients has a mailbox holding `closed`. */
async function answered(
  store: PausedExecutionRepository,
  id: string,
  answeredAt: number,
  tenantId = "default",
  recipients = RECIPIENTS,
): Promise<void> {
  await store.findOrCreateByStepKey({
    ...pauseOf(id, `run-1:${id}:1:call-1`),
    tenantId,
    rootExecutionId: `root-${id}`,
  });
  await store.markSentByTenantIdAndPauseId(tenantId, id, recipients);
  await store.resolveByTenantIdAndPauseId(
    tenantId,
    id,
    { decision: { approved: true }, actor: undefined },
    at(answeredAt),
    recipients,
  );
}

describe.each(kinds)("#1356: the mailboxes of the pause store %s", (_kind, make) => {
  it("claims the due mailboxes of the recipients asked for, oldest due first, at most `limit`, each under a token of its own", async () => {
    const store = make();
    await answered(store, "p-b", 20);
    await answered(store, "p-a", 10);
    await answered(store, "p-c", 30);

    const claims = await store.claimNoticesDue(at(100), 2, seconds(30), [CHANNEL]);

    expect(claims.map(({ mailbox }) => [mailbox.pauseId, mailbox.recipient])).toEqual([
      ["p-a", CHANNEL],
      ["p-b", CHANNEL],
    ]);
    expect(new Set(claims.map(({ token }) => token)).size).toBe(2);
    expect(claims.every(({ until }) => until.getTime() === at(130).getTime())).toBe(true);
    expect(claims[0]?.mailbox).toMatchObject({
      tenantId: "default",
      delivered: 0,
      attempts: 0,
      isDead: false,
    });
    expect(claims[0]?.mailbox.notices.map((notice) => notice.kind)).toEqual([
      PauseNoticeKind.Closed,
    ]);
    expect(await store.claimNoticesDue(at(100), 10, seconds(30), [])).toEqual([]);
    expect(await store.claimNoticesDue(at(100), 10, seconds(30), [LISTENER])).toEqual([]);
  });

  it("a recipient's mailboxes are its own: the listener's are not the channel's", async () => {
    const store = make();
    await answered(store, "p-a", 10, "default", BOTH);

    const far = new Date("2100-01-01T00:00:00.000Z");
    const listener = await store.claimNoticesDue(far, 10, seconds(30), [LISTENER]);
    const channel = await store.claimNoticesDue(far, 10, seconds(30), [CHANNEL]);

    expect(listener.map(({ mailbox }) => mailbox.recipient)).toEqual([LISTENER]);
    expect(listener[0]?.mailbox.notices.map((notice) => notice.kind)).toEqual([
      PauseNoticeKind.Opened,
      PauseNoticeKind.Closed,
    ]);
    expect(channel.map(({ mailbox }) => mailbox.recipient)).toEqual([CHANNEL]);
  });

  it("a mailbox is due at its time and not before, and claimed it is not due again until its claim is over", async () => {
    const store = make();
    await answered(store, "p-a", 10);

    expect(await store.claimNoticesDue(at(9), 10, seconds(30), [CHANNEL])).toEqual([]);
    const [first] = await store.claimNoticesDue(at(10), 10, seconds(30), [CHANNEL]);
    expect(first).toBeDefined();
    expect(await store.claimNoticesDue(at(39), 10, seconds(30), [CHANNEL])).toEqual([]);
    const [again] = await store.claimNoticesDue(at(40), 10, seconds(30), [CHANNEL]);
    expect(again?.mailbox.pauseId).toBe("p-a");
    expect(again?.token).not.toBe(first?.token);
  });

  it("acknowledges the head only while the claim is live: a lost token and an expired claim change nothing", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    await store.noticeOnceByTenantIdAndPauseId(
      "default",
      "p-a",
      PauseNoticeKind.JoinFailed,
      { launch: "launch-1", errorCode: "boom" },
      at(11),
      RECIPIENTS,
    );
    const [claim] = await store.claimNoticesDue(at(12), 1, seconds(30), [CHANNEL]);
    if (claim === undefined) throw new Error("nothing claimed");
    expect(claim.mailbox.notices.map((notice) => notice.kind)).toEqual([
      PauseNoticeKind.Closed,
      PauseNoticeKind.JoinFailed,
    ]);

    expect(await store.ackNotice({ ...claim, token: "lost" }, at(13))).toBeUndefined();
    expect(await store.ackNotice(claim, at(42))).toBeUndefined();
    expect(await store.ackNotice(claim, at(43))).toBeUndefined();
    expect((await store.countNotices()).live).toBe(1);

    // the first notice acknowledged leaves the claim on the second, as it was
    const next = await store.ackNotice(claim, at(20));
    expect(next).toMatchObject({ token: claim.token, mailbox: { delivered: 1, attempts: 0 } });
    expect(next?.until).toEqual(claim.until);
    // the last acknowledged releases the claim: it is the end of the mailbox, and a late ack finds none
    expect(await store.ackNotice(claim, at(21))).toBeUndefined();
    expect((await store.countNotices()).live).toBe(0);
    expect(await store.ackNotice(claim, at(22))).toBeUndefined();
  });

  it("renews a live claim to at + claimFor and never to an earlier time; a lapsed claim, a lost token and a gone mailbox are not revived", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    const [claim] = await store.claimNoticesDue(at(10), 1, seconds(30), [CHANNEL]);
    if (claim === undefined) throw new Error("nothing claimed");

    const longer = await store.renewNotice(claim, at(20), seconds(60));
    expect(longer?.until).toEqual(at(80));
    expect(longer?.token).toBe(claim.token);
    expect((await store.renewNotice(claim, at(21), seconds(10)))?.until).toEqual(at(80));
    expect((await store.renewNotice(claim, at(21), seconds(59)))?.until).toEqual(at(80));
    expect((await store.renewNotice(claim, at(21), seconds(60)))?.until).toEqual(at(81));
    expect(
      await store.renewNotice({ ...claim, token: "lost" }, at(22), seconds(60)),
    ).toBeUndefined();
    expect(await store.renewNotice(claim, at(81), seconds(60))).toBeUndefined();
    expect(await store.renewNotice(claim, at(200), seconds(60))).toBeUndefined();
  });

  it("a claim over at its second is not renewed; a claim of a mailbox no one holds any more is not either", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    const [claim] = await store.claimNoticesDue(at(10), 1, seconds(30), [CHANNEL]);
    if (claim === undefined) throw new Error("nothing claimed");

    expect(await store.renewNotice(claim, at(40), seconds(30))).toBeUndefined();
    // the last notice acknowledged: the claim is released, its token is the mailbox's no more
    expect(await store.ackNotice(claim, at(20))).toBeUndefined();
    expect(await store.renewNotice(claim, at(21), seconds(30))).toBeUndefined();
    expect(await store.retryNotice(claim, at(60), "boom")).toBe(false);
    expect(await store.setAsideNotices(claim, at(22), "boom")).toBe(false);
  });

  it("a retry keeps the problem and is due again at its time, not before, with the claim released", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    const [claim] = await store.claimNoticesDue(at(10), 1, seconds(30), [CHANNEL]);
    if (claim === undefined) throw new Error("nothing claimed");

    expect(await store.retryNotice({ ...claim, token: "lost" }, at(60), "boom")).toBe(false);
    expect(await store.retryNotice(claim, at(60), "boom")).toBe(true);

    expect(await store.claimNoticesDue(at(59), 1, seconds(30), [CHANNEL])).toEqual([]);
    const [again] = await store.claimNoticesDue(at(60), 1, seconds(30), [CHANNEL]);
    expect(again?.mailbox).toMatchObject({ attempts: 1, problem: "boom", delivered: 0 });
  });

  it("a mailbox set aside is dead, never claimed again, and counted as dead", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    const [claim] = await store.claimNoticesDue(at(10), 1, seconds(30), [CHANNEL]);
    if (claim === undefined) throw new Error("nothing claimed");
    const before = await store.countNotices();

    expect(await store.setAsideNotices({ ...claim, token: "lost" }, at(11), "boom")).toBe(false);
    expect(await store.setAsideNotices(claim, at(11), "boom")).toBe(true);

    expect(await store.claimNoticesDue(at(500), 10, seconds(30), [CHANNEL])).toEqual([]);
    const after = await store.countNotices();
    expect(after).toEqual({ live: before.live - 1, dead: before.dead + 1 });
  });

  it("a stale look takes the live, unclaimed mailboxes whose head was written before its cutoff, oldest head first, at most `limit`", async () => {
    const store = make();
    await answered(store, "p-c", 30);
    await answered(store, "p-b", 20);
    await answered(store, "p-a", 10);
    await answered(store, "p-d", 40);
    // p-a's mailbox is claimed, its claim not over at the look: not taken
    const [held] = await store.claimNoticesDue(at(50), 1, seconds(60), [CHANNEL]);
    expect(held?.mailbox.pauseId).toBe("p-a");

    const first = await store.setAsideStaleNoticesBefore(at(40), at(60), "stale", 1);
    const second = await store.setAsideStaleNoticesBefore(at(40), at(60), "stale", 10);
    const none = await store.setAsideStaleNoticesBefore(at(40), at(60), "stale", 10);

    expect(first).toEqual([{ tenantId: "default", pauseId: "p-b", recipient: CHANNEL }]);
    expect(second).toEqual([{ tenantId: "default", pauseId: "p-c", recipient: CHANNEL }]);
    expect(none).toEqual([]);
    expect(await store.countNotices()).toEqual({ live: 2, dead: 2 });
  });

  it("a stale look takes nothing whose head was written at or after its cutoff, and leaves a claim that is over to be taken", async () => {
    const store = make();
    await answered(store, "p-a", 10);

    expect(await store.setAsideStaleNoticesBefore(at(0), at(60), "stale", 10)).toEqual([]);
    const [held] = await store.claimNoticesDue(at(50), 10, seconds(10), [CHANNEL]);
    expect(held).toBeDefined();
    // claimed until second 60: at second 60 the claim is over
    const taken = await store.setAsideStaleNoticesBefore(at(1000), at(60), "stale", 10);
    expect(taken.map(({ recipient }) => recipient)).toContain(CHANNEL);
    expect(await store.setAsideStaleNoticesBefore(at(1000), at(60), "stale", 10)).toEqual([]);
  });

  it("a notice of a kind is written once per pause, in any of its mailboxes, and only for a pause that exists", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    await answered(store, "p-b", 10);
    const facts = { launch: "launch-1", errorCode: "boom" };
    const once = (tenant: string, id: string) =>
      store.noticeOnceByTenantIdAndPauseId(
        tenant,
        id,
        PauseNoticeKind.JoinFailed,
        facts,
        at(11),
        RECIPIENTS,
      );

    expect(await once("default", "p-a")).toBe(true);
    expect(await once("default", "p-a")).toBe(false);
    // another pause of the tenant is its own, and so is another tenant's with the same id
    expect(await once("default", "p-b")).toBe(true);
    expect(await once("default", "p-missing")).toBe(false);
    expect(await once("other", "p-a")).toBe(false);
  });

  it("a notice of a kind is not written again when one mailbox of the pause has it, though another has not", async () => {
    const store = make();
    await answered(store, "p-a", 10, "default", BOTH);
    const facts = { launch: "launch-1", errorCode: "boom" };
    const once = (recipients: typeof BOTH) =>
      store.noticeOnceByTenantIdAndPauseId(
        "default",
        "p-a",
        PauseNoticeKind.JoinFailed,
        facts,
        at(11),
        recipients,
      );

    // only the channel's mailbox has it; the listener's has not
    expect(await once(RECIPIENTS)).toBe(true);
    expect(await once(BOTH)).toBe(false);
  });

  it("a mailbox that is gone is not acknowledged, renewed, retried or set aside: its claim has nothing to hold", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    await store.markTakenByTenantIdAndPauseId("default", "p-a");
    const [claim] = await store.claimNoticesDue(at(10), 1, seconds(30), [CHANNEL]);
    if (claim === undefined) throw new Error("nothing claimed");
    await store.setAsideNotices(claim, at(11), "boom");
    await store.deleteByResolvedAtBefore(at(1000));

    expect(await store.ackNotice(claim, at(12))).toBeUndefined();
    expect(await store.renewNotice(claim, at(12), seconds(30))).toBeUndefined();
    expect(await store.retryNotice(claim, at(60), "boom")).toBe(false);
    expect(await store.setAsideNotices(claim, at(12), "boom")).toBe(false);
  });

  it("a closed pause with a live mailbox is kept by the retention; with none, or only dead and delivered ones, it goes with them", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    await answered(store, "p-b", 10);
    await store.markTakenByTenantIdAndPauseId("default", "p-a");
    await store.markTakenByTenantIdAndPauseId("default", "p-b");
    // p-b's mailboxes are all dead, p-a's are live
    const claims = await store.claimNoticesDue(at(10), 10, seconds(30), [CHANNEL, LISTENER]);
    for (const claim of claims.filter(({ mailbox }) => mailbox.pauseId === "p-b"))
      await store.setAsideNotices(claim, at(11), "boom");

    await store.deleteByResolvedAtBefore(at(1000));

    expect(await store.findByTenantIdAndPauseId("default", "p-a")).toBeDefined();
    expect(await store.findByTenantIdAndPauseId("default", "p-b")).toBeUndefined();
    // the mailboxes of the removed pause went with it; the kept one's are still there
    const left = await store.countNotices();
    expect(left.dead).toBe(0);
    expect(left.live).toBeGreaterThan(0);
  });

  it("a removal of one pause takes its mailboxes only, not another pause's, nor another tenant's of the same id", async () => {
    const store = make();
    await answered(store, "p-a", 10);
    await answered(store, "p-a", 10, "other");
    await store.markTakenByTenantIdAndPauseId("default", "p-a");
    const claims = await store.claimNoticesDue(at(10), 10, seconds(30), [CHANNEL, LISTENER]);
    for (const claim of claims.filter(({ mailbox }) => mailbox.tenantId === "default"))
      await store.setAsideNotices(claim, at(11), "boom");

    await store.deleteByResolvedAtBefore(at(1000));

    expect(await store.findByTenantIdAndPauseId("default", "p-a")).toBeUndefined();
    expect(await store.findByTenantIdAndPauseId("other", "p-a")).toBeDefined();
    const left = await store.countNotices();
    expect(left.dead).toBe(0);
    expect(left.live).toBeGreaterThan(0);
  });
});
