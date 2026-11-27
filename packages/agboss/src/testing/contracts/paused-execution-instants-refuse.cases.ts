import { expect } from "vitest";
import { StoreErrorKind } from "../../core/error-families/store-errors.js";
import { seenOf } from "../../infrastructure/pause-seen.js";
import { PauseStatus } from "../../infrastructure/pause-record.js";
import { APPROVED_BY_MANAGER, NINE } from "./paused-execution-data.js";
import {
  deadline,
  expectInstant,
  preciseOf,
  R,
  sameAs,
  stored,
  T,
  type Case,
  type Instances,
} from "./paused-execution-instants-data.js";

/**
 * #1307 (G3): a store refuses an Invalid Date (`new Date(NaN)`) before it writes anything, with a
 * `StoreError.UnreadableRecord` (kind `unreadable-record`) naming the field, never the value — the
 * error the contract already raises for a time it cannot keep or read back. A store that writes it
 * (`null` in JSON) holds a row it can never read again; one that keeps it holds a pause that is never
 * open, never due and never equal to anything.
 */
const INVALID = (): Date => new Date(Number.NaN);

/** The error the call raised (a throw before the promise included), or `undefined` when it resolved. */
const refusalOf = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectRefused = (error: unknown, what: string): void => {
  expect(error, `${what}: refused`).toMatchObject({ kind: StoreErrorKind.UnreadableRecord });
};

export const INSTANT_REFUSAL_CASES: readonly Case[] = [
  {
    name: "#1307: a pause with an Invalid Date in any of its times is refused with StoreError.UnreadableRecord, and nothing is written",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      const made = (): ReturnType<typeof preciseOf> => preciseOf("pause-a");
      const variants = {
        askedAt: { ...made(), askedAt: INVALID() },
        firstAskedAt: { ...made(), firstAskedAt: INVALID() },
        expiresAt: { ...made(), expiresAt: INVALID() },
        remindAt: { ...made(), remindAt: INVALID() },
        maxExpiresAt: { ...made(), maxExpiresAt: INVALID() },
        boundAt: { ...made(), boundAt: INVALID() },
        "trail[0].at": {
          ...made(),
          trail: [{ action: "opened" as const, at: INVALID(), target: "refund-tool-approval" }],
        },
      };

      for (const [field, pause] of Object.entries(variants)) {
        expectRefused(await refusalOf(() => one.findOrCreateByStepKey(pause)), field);
        expect(await second.findByTenantIdAndPauseId("default", "pause-a"), field).toBeUndefined();
      }
      // a refusal leaves the store as it was: the valid pause is made normally afterwards
      await one.findOrCreateByStepKey(made());
      expectInstant((await stored(second, "pause-a")).expiresAt, deadline(), "expiresAt");
    },
  },
  {
    name: "#1307: a transition at an Invalid Date, or a deadline change to one, is refused with StoreError.UnreadableRecord and the pause is as it was",
    run: async ({ first: one, second }: Instances): Promise<void> => {
      await one.findOrCreateByStepKey(preciseOf("pause-a"));
      const read = await stored(second, "pause-a");

      expectRefused(
        await refusalOf(() =>
          second.resolveByTenantIdAndPauseId(
            "default",
            "pause-a",
            APPROVED_BY_MANAGER,
            INVALID(),
            R,
          ),
        ),
        "resolve at",
      );
      expectRefused(
        await refusalOf(() =>
          second.changeTimeoutByTenantIdAndPauseId(
            "default",
            "pause-a",
            { expiresAt: INVALID(), previousExpiresAt: sameAs(deadline()), seen: seenOf(read) },
            NINE,
            R,
          ),
        ),
        "timeout change to",
      );
      expectRefused(
        await refusalOf(() =>
          second.changeTimeoutByTenantIdAndPauseId(
            "default",
            "pause-a",
            { expiresAt: T(122), previousExpiresAt: sameAs(deadline()), seen: seenOf(read) },
            INVALID(),
            R,
          ),
        ),
        "timeout change at",
      );

      const after = await stored(one, "pause-a");
      expect(after.status).toBe(PauseStatus.Pending);
      expectInstant(after.expiresAt, deadline(), "the deadline is untouched");
      expect(after.trail).toHaveLength(1);
    },
  },
];
