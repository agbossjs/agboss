import { expect } from "vitest";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import {
  PauseResolution,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  CHANNEL_KEY,
  DEADLINE,
  expiringPauseOf,
  LISTENER_KEYS,
  RECIPIENTS,
  MID,
} from "./paused-execution-data.js";
import { kindsOf, peeker } from "./paused-execution-mailboxes.js";

/** #910 AC2, I7: every transition writes its notices with its change, or nothing. */
type Instances = ContractInstances<PausedExecutionRepository>;
type Store = PausedExecutionRepository;

/** Each transition on its own sent pause, with the kind of notice it writes. */
const TRANSITIONS: readonly (readonly [
  string,
  (store: Store, id: string) => Promise<unknown>,
  string,
])[] = [
  [
    "resolve",
    (s, id) => s.resolveByTenantIdAndPauseId("default", id, APPROVED_BY_MANAGER, MID, RECIPIENTS),
    "closed",
  ],
  [
    "cancel",
    (s, id) =>
      s.cancelByTenantIdAndPauseId("default", id, PauseResolution.Cancelled, MID, RECIPIENTS),
    "closed",
  ],
  [
    "expire",
    (s, id) => s.expireByTenantIdAndPauseId("default", id, {}, DEADLINE, RECIPIENTS),
    "closed",
  ],
  [
    "extend",
    (s, id) =>
      s.extendByTenantIdAndPauseId(
        "default",
        id,
        { expiresAt: "2026-01-05T12:00:00.000Z" },
        MID,
        RECIPIENTS,
      ),
    "extended",
  ],
  ["remind", (s, id) => s.remindByTenantIdAndPauseId("default", id, MID, RECIPIENTS), "expiring"],
];

export const TRANSITION_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "every transition writes its notices or nothing: each kind to the receivers of its kind",
    run: async ({ first }: Instances): Promise<void> => {
      for (const [index] of TRANSITIONS.entries()) {
        const id = `p${String(index)}`;
        await first.findOrCreateByStepKey(expiringPauseOf(id, `run-1:s:1:${String(index)}`));
        await first.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
      }

      for (const [index, [, apply]] of TRANSITIONS.entries())
        expect(await apply(first, `p${String(index)}`)).toBeTruthy();

      const claims = await peeker(first)();
      for (const [index, [name, , kind]] of TRANSITIONS.entries()) {
        const id = `p${String(index)}`;
        expect(kindsOf(claims, id, CHANNEL_KEY), name).toEqual([kind]);
        for (const key of LISTENER_KEYS)
          expect(kindsOf(claims, id, key), name).toEqual(["opened", kind]);
      }
    },
  },
  {
    name: "a transition that has already applied writes nothing the second time, whoever repeats it",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [index] of TRANSITIONS.entries()) {
        const id = `p${String(index)}`;
        await first.findOrCreateByStepKey(expiringPauseOf(id, `run-1:s:1:${String(index)}`));
        await first.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
        await TRANSITIONS[index]?.[1](first, id);
      }
      const before = await first.countNotices();

      for (const [index, [name, apply]] of TRANSITIONS.entries()) {
        const again = await apply(second, `p${String(index)}`);
        // extend moves the deadline again: only that one may apply twice, once more, with a notice
        if (name !== "extend")
          expect(again, name).toSatisfy((value: unknown) => value === undefined || value === false);
      }

      const after = await first.countNotices();
      expect(after.dead).toBe(before.dead);
      expect(
        await first.cancelByTenantIdAndPauseId(
          "default",
          "p0",
          PauseResolution.Cancelled,
          MID,
          NO_RECIPIENTS,
        ),
      ).toBeUndefined();
    },
  },
];
