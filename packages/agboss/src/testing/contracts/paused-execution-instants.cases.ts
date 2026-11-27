import { expect } from "vitest";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
} from "../../infrastructure/pause-record.js";
import { seenOf } from "../../infrastructure/pause-seen.js";
import type {
  PausedExecutionRepository,
  PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  MID,
  NINE,
  pauseOf,
  RECIPIENTS,
} from "./paused-execution-data.js";
import { noticesOf, peeker } from "./paused-execution-mailboxes.js";

/**
 * #1307 (G3, Q-A): a pause's times are `Date`s in the contract; a store keeps them as it likes (ISO 8601
 * text in a raw column) and hands back a `Date` of the very millisecond it was given. These cases use
 * times with milliseconds and compare by instant: a store that truncates a time, reads text in the
 * wrong zone, hands out the instance it holds, or compares two `Date`s by reference fails one of them.
 */
type Instances = ContractInstances<PausedExecutionRepository>;
type Case = ContractCase<PausedExecutionRepository>;
const R = NO_RECIPIENTS;

/** A moment of the hour of 2026-01-05 10:00, `ms` milliseconds into its first second. */
const T = (ms: number): Date => new Date(Date.UTC(2026, 0, 5, 10, 0, 0, ms));
/** What the pause below is made with: every one of its times has milliseconds, and each call makes fresh `Date`s. */
const asked = (): Date => T(11);
const first = (): Date => T(7);
const deadline = (): Date => T(123);
const reminder = (): Date => T(45);
const cap = (): Date => new Date(Date.UTC(2026, 0, 5, 20, 0, 0, 999));

/** A pending pause every time of which has milliseconds; the moments the cases act at are before 10:00. */
export const preciseOf = (
  pauseId: string,
  stepKey = "run-1:clerk-agent:1:call-1",
): PauseRecord => ({
  ...pauseOf(pauseId, stepKey),
  askedAt: asked(),
  firstAskedAt: first(),
  maxExpiresAt: cap(),
  expiresAt: deadline(),
  remindAt: reminder(),
  boundAt: T(900),
  expiryBound: PauseExpiryBound.Pause,
  trail: [{ action: "opened", at: asked(), target: "refund-tool-approval", expiresAt: deadline() }],
});

const stored = async (store: PausedExecutionRepository, pauseId: string): Promise<PauseRecord> => {
  const found = await store.findByTenantIdAndPauseId("default", pauseId);
  if (found === undefined) return expect.fail(`pause ${pauseId} is stored`);
  return found;
};

/** The same instant as `at`, in a `Date` that is no one else's. */
const sameAs = (at: Date): Date => new Date(at.getTime());
/** One millisecond off `at`. */
const off = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

const expectInstant = (value: Date | undefined, expected: Date, what: string): void => {
  expect(value, what).toBeInstanceOf(Date);
  expect(value?.getTime(), what).toBe(expected.getTime());
};

export const INSTANT_CASES: readonly Case[] = [
  {
    name: "#1307: every time of a pause comes back as a Date of the very millisecond it was given, on the other instance too",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));

      const read = await stored(second, "pause-a");

      expectInstant(read.askedAt, asked(), "askedAt");
      expectInstant(read.firstAskedAt, first(), "firstAskedAt");
      expectInstant(read.expiresAt, deadline(), "expiresAt");
      expectInstant(read.remindAt, reminder(), "remindAt");
      expectInstant(read.maxExpiresAt, cap(), "maxExpiresAt");
      expectInstant(read.boundAt, T(900), "boundAt");
      expectInstant(read.trail[0]?.at, asked(), "trail[0].at");
      expectInstant(read.trail[0]?.expiresAt, deadline(), "trail[0].expiresAt");
    },
  },
  {
    name: "#1307: the times a transition writes come back as Dates of the very millisecond, closedFirst's too",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      await one.findOrCreateByStepKey(preciseOf("pause-b", "run-1:clerk-agent:1:call-2"));
      const answeredAt = T(77);
      const closedAt = T(88);

      await second.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        answeredAt,
        R,
      );
      await one.closeUntakenByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.TreeEnded,
        closedAt,
        R,
      );
      await second.cancelByTenantIdAndPauseId(
        "default",
        "pause-b",
        PauseResolution.Cancelled,
        closedAt,
        R,
      );

      const a = await stored(one, "pause-a");
      expectInstant(a.resolvedAt, closedAt, "a: resolvedAt after the untaken close");
      expectInstant(a.closedFirst?.resolvedAt, answeredAt, "a: closedFirst.resolvedAt");
      expectInstant((await stored(second, "pause-b")).resolvedAt, closedAt, "b: resolvedAt");
    },
  },
  {
    name: "#1307: a Date handed to the store is copied, and a Date handed back is the caller's own: moving either moves nothing the store holds",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      const given = preciseOf("pause-a");
      await one.findOrCreateByStepKey(given);

      // the instances the caller still holds
      given.expiresAt?.setTime(0);
      given.remindAt?.setTime(0);
      given.askedAt.setTime(0);
      given.trail[0]?.at.setTime(0);
      // the instances a read handed out
      const read = await stored(second, "pause-a");
      read.expiresAt?.setTime(0);
      read.trail[0]?.expiresAt?.setTime(0);
      read.firstAskedAt.setTime(0);

      const again = await stored(one, "pause-a");
      expectInstant(again.expiresAt, deadline(), "expiresAt");
      expectInstant(again.remindAt, reminder(), "remindAt");
      expectInstant(again.askedAt, asked(), "askedAt");
      expectInstant(again.firstAskedAt, first(), "firstAskedAt");
      expectInstant(again.trail[0]?.at, asked(), "trail[0].at");
      expectInstant(again.trail[0]?.expiresAt, deadline(), "trail[0].expiresAt");
      const scanned = await second.findPendingByExpiresAtBefore(T(500), 10);
      scanned[0]?.expiresAt?.setTime(0);
      expectInstant((await stored(one, "pause-a")).expiresAt, deadline(), "expiresAt after a scan");
    },
  },
  {
    name: "#1307: a timeout change is a compare-and-set by instant: another Date of the deadline read wins, one millisecond off loses",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const read = await stored(second, "pause-a");
      const change = (previousExpiresAt: Date, seenAt: Date | undefined) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          {
            expiresAt: MID,
            previousExpiresAt,
            seen: { ...seenOf(read), ...(seenAt === undefined ? {} : { expiresAt: seenAt }) },
          },
          NINE,
          R,
        );

      // a deadline another writer moved by a millisecond is not the one the caller read
      expect(await change(off(deadline(), -1), undefined)).toBeUndefined();
      expect(await change(off(deadline(), 1), undefined)).toBeUndefined();
      expect(await change(sameAs(deadline()), off(deadline(), -1))).toBeUndefined();
      expect(await change(sameAs(deadline()), off(deadline(), 1))).toBeUndefined();
      expectInstant((await stored(one, "pause-a")).expiresAt, deadline(), "still the deadline");
      const won = await change(sameAs(deadline()), sameAs(deadline()));
      expectInstant(won?.expiresAt, MID, "the new deadline");
    },
  },
  {
    name: "#1307: an answer, a channel's decision and an in-place reassignment planned over the deadline read apply only while the deadline is that very instant",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      for (const id of ["pause-a", "pause-b", "pause-c"])
        await one.findOrCreateByStepKey(preciseOf(id, `run-1:clerk-agent:1:${id}`));
      const seenOver = async (id: string, expiresAt: Date) => ({
        ...seenOf(await stored(second, id)),
        expiresAt,
      });

      // one millisecond off: refused, whatever the call
      expect(
        await second.resolveByTenantIdAndPauseId(
          "default",
          "pause-a",
          APPROVED_BY_MANAGER,
          NINE,
          R,
          await seenOver("pause-a", off(deadline(), 1)),
        ),
      ).toBeUndefined();
      expect(
        await second.decideByTenantIdAndPauseId(
          "default",
          "pause-b",
          DECIDED_ANSWER,
          NINE,
          await seenOver("pause-b", off(deadline(), -1)),
        ),
      ).toBe(false);
      expect(
        await second.reassignByTenantIdAndPauseId(
          "default",
          "pause-c",
          { assignees: ["x"], seen: await seenOver("pause-c", off(deadline(), 1)) },
          NINE,
          R,
        ),
      ).toBeUndefined();
      // the same instant in another Date: applies
      expect(
        await second.resolveByTenantIdAndPauseId(
          "default",
          "pause-a",
          APPROVED_BY_MANAGER,
          NINE,
          R,
          await seenOver("pause-a", sameAs(deadline())),
        ),
      ).toMatchObject({ status: PauseStatus.Resolved });
      expect(
        await second.decideByTenantIdAndPauseId(
          "default",
          "pause-b",
          DECIDED_ANSWER,
          NINE,
          await seenOver("pause-b", sameAs(deadline())),
        ),
      ).toBe(true);
      expect(
        (
          await second.reassignByTenantIdAndPauseId(
            "default",
            "pause-c",
            { assignees: ["x"], seen: await seenOver("pause-c", sameAs(deadline())) },
            NINE,
            R,
          )
        )?.assignees,
      ).toEqual(["x"]);
    },
  },
  {
    name: "#1307: the cap is kept by instant: a deadline at maxExpiresAt (another Date of it) is allowed, one millisecond past it is refused",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const change = async (expiresAt: Date) =>
        second.changeTimeoutByTenantIdAndPauseId(
          "default",
          "pause-a",
          {
            expiresAt,
            previousExpiresAt: sameAs(deadline()),
            seen: seenOf(await stored(second, "pause-a")),
          },
          NINE,
          R,
        );

      expect(await change(off(cap(), 1))).toBeUndefined();
      const allowed = await change(sameAs(cap()));
      expectInstant(allowed?.expiresAt, cap(), "a deadline exactly at the cap");
    },
  },
  {
    name: "#1307: a pause is open and due by the millisecond: an answer 1 ms before the deadline is taken, at it refused; the scans and their keyset read the same instants",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      await one.findOrCreateByStepKey(preciseOf("pause-b", "run-1:clerk-agent:1:call-2"));

      expect(
        await second.resolveByTenantIdAndPauseId(
          "default",
          "pause-b",
          APPROVED_BY_MANAGER,
          deadline(),
          R,
        ),
      ).toBeUndefined();
      expect(
        (
          await second.resolveByTenantIdAndPauseId(
            "default",
            "pause-b",
            APPROVED_BY_MANAGER,
            off(deadline(), -1),
            R,
          )
        )?.status,
      ).toBe(PauseStatus.Resolved);
      const due = (at: Date, after?: { at: Date; tenantId: string; pauseId: string }) =>
        second.findPendingByExpiresAtBefore(at, 10, after);
      expect((await due(off(deadline(), -1))).map((p) => p.pauseId)).toEqual([]);
      expect((await due(deadline())).map((p) => p.pauseId)).toEqual(["pause-a"]);
      const key = { tenantId: "default", pauseId: "pause-a" };
      expect(
        (await due(T(500), { ...key, at: off(deadline(), -1) })).map((p) => p.pauseId),
      ).toEqual(["pause-a"]);
      expect((await due(T(500), { ...key, at: sameAs(deadline()) })).map((p) => p.pauseId)).toEqual(
        [],
      );
      const remind = (at: Date) => second.findPendingByRemindAtBefore(at, 10);
      expect((await remind(off(reminder(), -1))).map((p) => p.pauseId)).toEqual([]);
      expect((await remind(reminder())).map((p) => p.pauseId)).toEqual(["pause-a"]);
    },
  },
  {
    name: "#1307: the times of a notice are Dates of the very millisecond: when it was written, when the pause closed, the deadline it names",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      await second.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
      const answeredAt = T(77);
      await one.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        answeredAt,
        RECIPIENTS,
      );

      const claims = await peeker(second)();
      const [opened, closed] = noticesOf(claims, "pause-a", "listener:slack-listener");
      const box = claims.find((claim) => claim.mailbox.recipient === "listener:slack-listener");

      expectInstant(opened?.writtenAt, asked(), "opened: writtenAt");
      expectInstant(opened?.expiresAt, deadline(), "opened: expiresAt");
      expectInstant(closed?.writtenAt, answeredAt, "closed: writtenAt");
      expectInstant(closed?.closedAt, answeredAt, "closed: closedAt");
      expectInstant(box?.mailbox.headWrittenAt, asked(), "mailbox: headWrittenAt");
      expect(box?.mailbox.nextAttemptAt).toBeInstanceOf(Date);
      expect(box?.until).toBeInstanceOf(Date);
    },
  },
];
