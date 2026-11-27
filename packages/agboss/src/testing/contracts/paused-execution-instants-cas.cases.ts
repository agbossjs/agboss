import { expect } from "vitest";
import { PauseStatus } from "../../infrastructure/pause-record.js";
import { seenOf } from "../../infrastructure/pause-seen.js";
import type { PauseScanAfter } from "../../infrastructure/pause-notices.js";
import {
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  MID,
  NINE,
  RECIPIENTS,
} from "./paused-execution-data.js";
import {
  asked,
  cap,
  deadline,
  expectInstant,
  off,
  preciseOf,
  R,
  reminder,
  sameAs,
  stored,
  T,
  type Case,
  type Instances,
} from "./paused-execution-instants-data.js";
import { noticesOf, peeker } from "./paused-execution-mailboxes.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";

/** #1307 (G3): what a store compares of a pause's times it compares by instant, never by the `Date` object. */

/** Three pauses that wait under the precise deadline, to be answered, decided and reassigned over a `seen`. */
const threePausesOver = async (one: PausedExecutionRepository): Promise<void> => {
  for (const id of ["pause-a", "pause-b", "pause-c"])
    await one.findOrCreateByStepKey(preciseOf(id, `run-1:clerk-agent:1:${id}`));
};

/** What the pause `id` is now, with its deadline replaced by `expiresAt`: the `seen` of a plan made over another read. */
const seenOver = async (store: PausedExecutionRepository, id: string, expiresAt: Date) => ({
  ...seenOf(await stored(store, id)),
  expiresAt,
});

/** The three calls over `seen` of one deadline: an answer, a decision at once, an in-place reassignment. */
const callsOver = (store: PausedExecutionRepository, expiresAt: Date) => ({
  resolve: async () =>
    store.resolveByTenantIdAndPauseId(
      "default",
      "pause-a",
      APPROVED_BY_MANAGER,
      NINE,
      R,
      await seenOver(store, "pause-a", expiresAt),
    ),
  decide: async () =>
    store.decideByTenantIdAndPauseId(
      "default",
      "pause-b",
      DECIDED_ANSWER,
      NINE,
      await seenOver(store, "pause-b", expiresAt),
    ),
  reassign: async () =>
    store.reassignByTenantIdAndPauseId(
      "default",
      "pause-c",
      { assignees: ["x"], seen: await seenOver(store, "pause-c", expiresAt) },
      NINE,
      R,
    ),
});

const idsOf = (pauses: readonly { readonly pauseId: string }[]): string[] =>
  pauses.map((pause) => pause.pauseId);

export const INSTANT_CAS_CASES: readonly Case[] = [
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
    name: "#1307: an answer, a channel's decision and an in-place reassignment planned over a deadline one millisecond off are refused",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await threePausesOver(one);

      const later = callsOver(second, off(deadline(), 1));
      const earlier = callsOver(second, off(deadline(), -1));

      expect(await later.resolve()).toBeUndefined();
      expect(await earlier.decide()).toBe(false);
      expect(await later.reassign()).toBeUndefined();
    },
  },
  {
    name: "#1307: an answer, a channel's decision and an in-place reassignment planned over the very instant of the deadline, in another Date, apply",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await threePausesOver(one);

      const same = callsOver(second, sameAs(deadline()));

      expect(await same.resolve()).toMatchObject({ status: PauseStatus.Resolved });
      expect(await same.decide()).toBe(true);
      expect((await same.reassign())?.assignees).toEqual(["x"]);
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
    name: "#1307: a pause is open by the millisecond: an answer 1 ms before the deadline is taken, at it refused",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const answerAt = (at: Date) =>
        second.resolveByTenantIdAndPauseId("default", "pause-a", APPROVED_BY_MANAGER, at, R);

      expect(await answerAt(deadline())).toBeUndefined();
      expect((await answerAt(off(deadline(), -1)))?.status).toBe(PauseStatus.Resolved);
    },
  },
  {
    name: "#1307: the deadline and reminder scans and their keyset read the same instants, to the millisecond",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const due = (at: Date, after?: PauseScanAfter) =>
        second.findPendingByExpiresAtBefore(at, 10, after).then(idsOf);
      const remind = (at: Date) => second.findPendingByRemindAtBefore(at, 10).then(idsOf);
      const key = { tenantId: "default", pauseId: "pause-a" };

      expect(await due(off(deadline(), -1))).toEqual([]);
      expect(await due(deadline())).toEqual(["pause-a"]);
      expect(await due(T(500), { ...key, at: off(deadline(), -1) })).toEqual(["pause-a"]);
      expect(await due(T(500), { ...key, at: sameAs(deadline()) })).toEqual([]);
      expect(await remind(off(reminder(), -1))).toEqual([]);
      expect(await remind(reminder())).toEqual(["pause-a"]);
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
