import { PauseResolution } from "../../infrastructure/pause-record.js";
import { APPROVED_BY_MANAGER } from "./paused-execution-data.js";
import {
  asked,
  cap,
  deadline,
  expectInstant,
  first,
  preciseOf,
  R,
  reminder,
  stored,
  T,
  type Case,
  type Instances,
} from "./paused-execution-instants-data.js";
import { INSTANT_CAS_CASES } from "./paused-execution-instants-cas.cases.js";
import { INSTANT_COPY_CASES } from "./paused-execution-instants-copy.cases.js";
import { INSTANT_KEYSET_CASES } from "./paused-execution-instants-keyset.cases.js";
import { INSTANT_REFUSAL_CASES } from "./paused-execution-instants-refuse.cases.js";

/**
 * #1307 (G3, Q-A): a pause's times are `Date`s in the contract; a store keeps them as it likes (ISO 8601
 * text in a raw column) and hands back a `Date` of the very millisecond it was given. These cases use
 * times with milliseconds and compare by instant: a store that truncates a time, reads text in the
 * wrong zone, hands out the instance it holds, or compares two `Date`s by reference fails one of them.
 * Here: what comes back and the copies; `paused-execution-instants-cas.cases.ts`: what is compared.
 */
const READ_CASES: readonly Case[] = [
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
    name: "#1307: a Date handed to the store is copied: moving the caller's instance afterwards moves nothing the store holds",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      const given = preciseOf("pause-a");
      await one.findOrCreateByStepKey(given);

      given.expiresAt?.setTime(0);
      given.remindAt?.setTime(0);
      given.askedAt.setTime(0);
      given.trail[0]?.at.setTime(0);

      const again = await stored(second, "pause-a");
      expectInstant(again.expiresAt, deadline(), "expiresAt");
      expectInstant(again.remindAt, reminder(), "remindAt");
      expectInstant(again.askedAt, asked(), "askedAt");
      expectInstant(again.trail[0]?.at, asked(), "trail[0].at");
    },
  },
  {
    name: "#1307: a Date handed back is the caller's own: moving the instance of a read or of a scan moves nothing the store holds",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));

      const read = await stored(second, "pause-a");
      read.expiresAt?.setTime(0);
      read.trail[0]?.expiresAt?.setTime(0);
      read.firstAskedAt.setTime(0);
      const scanned = await second.findPendingByExpiresAtBefore(T(500), 10);
      scanned[0]?.expiresAt?.setTime(0);

      const again = await stored(one, "pause-a");
      expectInstant(again.expiresAt, deadline(), "expiresAt");
      expectInstant(again.firstAskedAt, first(), "firstAskedAt");
      expectInstant(again.trail[0]?.expiresAt, deadline(), "trail[0].expiresAt");
    },
  },
];

export const INSTANT_CASES: readonly Case[] = [
  ...READ_CASES,
  ...INSTANT_COPY_CASES,
  ...INSTANT_CAS_CASES,
  ...INSTANT_KEYSET_CASES,
  ...INSTANT_REFUSAL_CASES,
];
