import { expect } from "vitest";
import type { PauseScanAfter } from "../../infrastructure/pause-notices.js";
import type {
  PausedExecutionRepository,
  PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { expiringPauseOf } from "./paused-execution-data.js";

/** #1070: the due scan's keyset — a look that cannot move the first page still reaches the next. */
type Instances = ContractInstances<PausedExecutionRepository>;

const minute = (n: number): string => `2026-01-05T10:${String(n).padStart(2, "0")}:00.000Z`;
const dueAt = (n: number, tenant: string): PauseRecord => ({
  ...expiringPauseOf(`p${String(n)}`, `run-1:s:1:${String(n)}`),
  tenantId: tenant,
  expiresAt: minute(n),
});
const remindingAt = (n: number, tenant: string): PauseRecord => ({
  ...dueAt(n, tenant),
  expiresAt: minute(30),
  remindAt: minute(n),
});
/** One pause of a tie: its own id and step key, the deadline, reminder and tenant the others have. */
const tied = (n: number): PauseRecord => ({
  ...remindingAt(1, "default"),
  expiresAt: minute(1),
  pauseId: `t${String(n)}`,
  stepKey: `run-1:s:1:t${String(n)}`,
});
const keys = (pauses: readonly PauseRecord[]): string[] =>
  pauses.map((pause) => `${pause.tenantId}/${pause.pauseId}@${pause.expiresAt ?? ""}`);
const remindKeys = (pauses: readonly PauseRecord[]): string[] =>
  pauses.map((pause) => `${pause.tenantId}/${pause.pauseId}@${pause.remindAt ?? ""}`);
const keysetOf = (
  pause: PauseRecord | undefined,
  column: "expiresAt" | "remindAt" = "expiresAt",
): PauseScanAfter => ({
  at: pause?.[column] ?? "",
  tenantId: pause?.tenantId ?? "",
  pauseId: pause?.pauseId ?? "",
});

export const KEYSET_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "#1070: findPendingByExpiresAtBefore after a keyset continues past it in (deadline, tenant, id) order: pages join to the whole scan, pauses that stay pending are not read again",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [n, tenant] of [
        [3, "default"],
        [1, "acme"],
        [2, "default"],
        [1, "default"],
        [3, "acme"],
        [9, "default"],
      ] as const)
        await first.findOrCreateByStepKey(dueAt(n, tenant));
      const at = new Date(minute(5));
      const whole = await second.findPendingByExpiresAtBefore(at, 10);

      // (at most as many pages as pauses: a store that ignores `after` repeats a page, never loops)
      const paged: PauseRecord[] = [];
      let after: PauseScanAfter | undefined;
      let pages = 0;
      while (pages < whole.length) {
        pages += 1;
        const page = await second.findPendingByExpiresAtBefore(at, 2, after);
        paged.push(...page);
        if (page.length < 2) break;
        after = keysetOf(page.at(-1));
      }

      expect(keys(whole)).toHaveLength(5);
      expect(keys(paged)).toEqual(keys(whole));
      // a keyset past the last pause reads nothing; one before the first reads it all
      expect(await second.findPendingByExpiresAtBefore(at, 10, keysetOf(whole.at(-1)))).toEqual([]);
      const before = { ...keysetOf(whole[0]), tenantId: "", pauseId: "" };
      expect(keys(await second.findPendingByExpiresAtBefore(at, 10, before))).toEqual(keys(whole));
    },
  },
  {
    name: "#942: findPendingByRemindAtBefore after a keyset continues past it in (reminder, tenant, id) order: pages join to the whole scan, reminders that stay due are not read again",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [n, tenant] of [
        [3, "default"],
        [1, "acme"],
        [2, "default"],
        [1, "default"],
        [3, "acme"],
        [9, "default"],
      ] as const)
        await first.findOrCreateByStepKey(remindingAt(n, tenant));
      const at = new Date(minute(5));
      const whole = await second.findPendingByRemindAtBefore(at, 10);

      // (at most as many pages as pauses: a store that ignores `after` repeats a page, never loops)
      const paged: PauseRecord[] = [];
      let after: PauseScanAfter | undefined;
      let pages = 0;
      while (pages < whole.length) {
        pages += 1;
        const page = await second.findPendingByRemindAtBefore(at, 2, after);
        paged.push(...page);
        if (page.length < 2) break;
        after = keysetOf(page.at(-1), "remindAt");
      }

      expect(remindKeys(whole)).toHaveLength(5);
      expect(remindKeys(paged)).toEqual(remindKeys(whole));
      const last = keysetOf(whole.at(-1), "remindAt");
      expect(await second.findPendingByRemindAtBefore(at, 10, last)).toEqual([]);
      const before = { ...keysetOf(whole[0], "remindAt"), tenantId: "", pauseId: "" };
      expect(remindKeys(await second.findPendingByRemindAtBefore(at, 10, before))).toEqual(
        remindKeys(whole),
      );
    },
  },
  {
    name: "#1070: due pauses of one tenant with the same time are paged by their id: a page boundary between them loses none and repeats none",
    run: async ({ first, second }: Instances): Promise<void> => {
      // five pauses of one tenant, one time: only the pause id orders them
      for (const n of [4, 2, 5, 1, 3]) await first.findOrCreateByStepKey(tied(n));
      const at = new Date(minute(5));
      const scan = (limit: number, after?: PauseScanAfter) =>
        expiresAt === "expiresAt"
          ? second.findPendingByExpiresAtBefore(at, limit, after)
          : second.findPendingByRemindAtBefore(at, limit, after);
      const whole = await scan(10);

      const paged: PauseRecord[] = [];
      let after: PauseScanAfter | undefined;
      let pages = 0;
      while (pages < whole.length) {
        pages += 1;
        const page = await scan(2, after);
        paged.push(...page);
        if (page.length < 2) break;
        after = keysetOf(page.at(-1), "expiresAt");
      }

      expect(whole).toHaveLength(5);
      expect(whole.map((pause) => pause.pauseId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
      expect(paged.map((pause) => pause.pauseId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    },
  },
  {
    name: "#942: due pauses of one tenant with the same time are paged by their id: a page boundary between them loses none and repeats none",
    run: async ({ first, second }: Instances): Promise<void> => {
      // five pauses of one tenant, one time: only the pause id orders them
      for (const n of [4, 2, 5, 1, 3]) await first.findOrCreateByStepKey(tied(n));
      const at = new Date(minute(5));
      const scan = (limit: number, after?: PauseScanAfter) =>
        remindAt === "expiresAt"
          ? second.findPendingByExpiresAtBefore(at, limit, after)
          : second.findPendingByRemindAtBefore(at, limit, after);
      const whole = await scan(10);

      const paged: PauseRecord[] = [];
      let after: PauseScanAfter | undefined;
      let pages = 0;
      while (pages < whole.length) {
        pages += 1;
        const page = await scan(2, after);
        paged.push(...page);
        if (page.length < 2) break;
        after = keysetOf(page.at(-1), "remindAt");
      }

      expect(whole).toHaveLength(5);
      expect(whole.map((pause) => pause.pauseId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
      expect(paged.map((pause) => pause.pauseId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    },
  },
];
