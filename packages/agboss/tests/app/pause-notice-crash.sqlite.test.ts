/**
 * #940 AC3 on SQLite, two application instances on one file: the instance that wrote a notice dies
 * — after the close committed and before any delivery, or after the delivery and before its
 * acknowledgement — and the other delivers it: at least once, under the same `deliveryId`, never in
 * the wrong order; a zombie's late acknowledgement changes nothing; two instances never deliver
 * one mailbox at once. (The processes killed for real: the fault suite's scenario 21.)
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ApplicationContext, SqlitePausedExecutionRepository } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  Charge,
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  deliveries,
  gate,
  SqliteNoticesApplication,
} from "../infrastructure/sqlite/fixtures/pause-notices.application.js";

sqliteFilePerTest();

const test = testWith(SqliteNoticesApplication, { instances: 2 });
const approve = { approved: true };
const KEYS = ["listener:crash-pause-listener"];

beforeEach(() => {
  resetRecovery();
  deliveries.length = 0;
  gate.active = 0;
  gate.widest = 0;
  delete gate.hold;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** What each instance's listener was told, by instance index, in order. */
const toldTo = (apps: readonly TestApp[], index: number): string[] => {
  const { instanceId } = instance(apps, index).resolve(ApplicationContext);
  return deliveries.filter((one) => one.instance === instanceId).map((one) => one.notice);
};

describe("#940 AC3: an instance that wrote a notice dies, the other delivers it", () => {
  test("AC3: dead after the close committed, before any delivery: the other delivers opened, then closed — once each", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    for (const app of apps) await app.ready();
    // instance 1 never claims a notice again: its process is gone
    vi.spyOn(
      instance(apps, 0).resolve(SqlitePausedExecutionRepository),
      "claimNoticesDue",
    ).mockResolvedValue([]);
    const paused = await execute(instance(apps, 0), OrderWorkflowStart, { text: "charge" });
    await instance(apps, 0).resume(answerOf(paused, approve));
    expect(deliveries).toEqual([]);

    await clock.advance(seconds(5));

    await until(() => deliveries.length === 2);
    expect(toldTo(apps, 1)).toEqual(["opened", "closed"]);
    expect(toldTo(apps, 0)).toEqual([]);
  });

  test("AC3: dead after the delivery, before its acknowledgement: delivered again, the same deliveryId, in order", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    for (const app of apps) await app.ready();
    const store = instance(apps, 0).resolve(SqlitePausedExecutionRepository);
    // instance 1 delivers, and dies before the acknowledgement is written
    vi.spyOn(store, "ackNotice").mockRejectedValueOnce(new Error("the process died"));
    vi.spyOn(
      instance(apps, 1).resolve(SqlitePausedExecutionRepository),
      "claimNoticesDue",
    ).mockResolvedValue([]);
    await execute(instance(apps, 0), OrderWorkflowStart, { text: "charge" });
    await until(() => deliveries.length === 1);

    // the claim lapses (60 s): the other instance's look delivers it again
    vi.spyOn(
      instance(apps, 1).resolve(SqlitePausedExecutionRepository),
      "claimNoticesDue",
    ).mockRestore();
    await clock.advance(seconds(65));

    await until(() => deliveries.length >= 2);
    const [first, again] = deliveries;
    expect(again?.deliveryId).toBe(first?.deliveryId);
    expect(again?.notice).toBe("opened");
  });

  test("AC3: a zombie's late acknowledgement changes nothing: the mailbox keeps what the new claim did", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    for (const app of apps) await app.ready();
    const zombie = instance(apps, 0).resolve(SqlitePausedExecutionRepository);
    const holder = instance(apps, 1).resolve(SqlitePausedExecutionRepository);
    // neither instance delivers by itself: the test drives the claims
    for (const store of [zombie, holder]) {
      vi.spyOn(store, "claimNoticesDue").mockResolvedValue([]);
    }
    await execute(instance(apps, 0), OrderWorkflowStart, { text: "charge" });
    const at = new Date();
    const claimOf = (store: SqlitePausedExecutionRepository, when: Date) =>
      SqlitePausedExecutionRepository.prototype.claimNoticesDue.call(
        store,
        when,
        10,
        seconds(60),
        KEYS,
      );
    const [stale] = await claimOf(zombie, at);
    const later = new Date(at.getTime() + 61_000);
    const [fresh] = await claimOf(holder, later);
    if (stale === undefined || fresh === undefined) throw new Error("the claims were expected");

    // the zombie's ack comes first and late: refused, the notice is still waiting
    const lateAck = await zombie.ackNotice(stale, later);
    expect(lateAck).toBeUndefined();
    expect(await holder.countNotices()).toEqual({ live: 1, dead: 0 });
    // the new holder's ack counts
    expect(await holder.ackNotice(fresh, later)).toBeUndefined();
    expect(await holder.countNotices()).toEqual({ live: 0, dead: 0 });
  });

  test("AC3: two instances look at once: a mailbox is delivered by one at a time, opened before closed", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    for (const app of apps) await app.ready();
    let release: () => void = () => undefined;
    gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = await execute(instance(apps, 0), OrderWorkflowStart, { text: "charge" });
    await until(() => deliveries.length === 1);
    await instance(apps, 1).resume(answerOf(paused, approve));

    // both instances' timers look while the first delivery is still running
    await clock.advance(seconds(10));
    expect(deliveries).toHaveLength(1);
    release();
    await clock.advance(seconds(10));

    await until(() => deliveries.length === 2);
    expect(deliveries.map((one) => one.notice)).toEqual(["opened", "closed"]);
    expect(gate.widest).toBe(1);
  });
});
