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
const keys = (pauses: readonly PauseRecord[]): string[] =>
  pauses.map((pause) => `${pause.tenantId}/${pause.pauseId}@${pause.expiresAt ?? ""}`);
const keysetOf = (pause: PauseRecord | undefined): PauseScanAfter => ({
  at: pause?.expiresAt ?? "",
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
];
