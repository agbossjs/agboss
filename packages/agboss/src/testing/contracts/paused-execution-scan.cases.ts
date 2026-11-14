import { expect } from "vitest";
import {
  PauseResolution,
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { PauseScanAfter } from "../../infrastructure/pause-notices.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  expiringPauseOf,
  NINE,
  pausedRunOf,
  TEN,
} from "./paused-execution-data.js";

/** #910 AC5, I11: the scans by deadline, reminder and cursor, and the retention. */
type Instances = ContractInstances<PausedExecutionRepository>;
type Store = PausedExecutionRepository;
const ids = (pauses: readonly PauseRecord[]): readonly string[] =>
  pauses.map((pause) => pause.pauseId);
const keyOf = (n: number): string => `run-1:s:1:${String(n)}`;
const minute = (n: number): string => `2026-01-05T10:${String(n).padStart(2, "0")}:00.000Z`;

/** Pause `p<n>` of `tenant`, due at minute `n`, reminded at minute `n` of the hour before. */
const dueAt = (n: number, tenant = "default"): PauseRecord => ({
  ...expiringPauseOf(`p${String(n)}`, keyOf(n)),
  tenantId: tenant,
  expiresAt: minute(n),
  remindAt: minute(n).replace("T10", "T09"),
});

export const SCAN_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "findPendingByExpiresAtBefore: every tenant, by deadline then tenant and id, at most limit; findPendingByRemindAtBefore the same on remindAt",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const [n, tenant] of [
        [3, "default"],
        [1, "acme"],
        [2, "default"],
        [1, "default"],
        [9, "default"],
      ] as const)
        await first.findOrCreateByStepKey(dueAt(n, tenant));
      await first.resolveByTenantIdAndPauseId(
        "default",
        "p2",
        APPROVED_BY_MANAGER,
        new Date(minute(0)),
        { listeners: [] },
      );

      const due = await second.findPendingByExpiresAtBefore(new Date(minute(3)), 10);
      const reminded = await second.findPendingByRemindAtBefore(
        new Date(minute(3).replace("T10", "T09")),
        10,
      );

      expect(due.map((pause) => `${pause.tenantId}/${pause.pauseId}`)).toEqual([
        "acme/p1",
        "default/p1",
        "default/p3",
      ]);
      expect(ids(await second.findPendingByExpiresAtBefore(new Date(minute(3)), 2))).toEqual([
        "p1",
        "p1",
      ]);
      expect(reminded.map((pause) => `${pause.tenantId}/${pause.pauseId}`)).toEqual([
        "acme/p1",
        "default/p1",
        "default/p3",
      ]);
      expect(await second.findPendingByExpiresAtBefore(new Date(minute(0)), 1000)).toEqual([]);
    },
  },
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
      const keys = (pauses: readonly PauseRecord[]): string[] =>
        pauses.map((pause) => `${pause.tenantId}/${pause.pauseId}@${pause.expiresAt ?? ""}`);

      const paged: PauseRecord[] = [];
      // (at most as many pages as pauses: a store that ignores `after` repeats a page, never loops)
      let after: PauseScanAfter | undefined;
      for (let pages = 0; pages < whole.length; pages += 1) {
        const page = await second.findPendingByExpiresAtBefore(at, 2, after);
        paged.push(...page);
        const last = page.at(-1);
        if (last === undefined || page.length < 2) break;
        after = { at: last.expiresAt ?? "", tenantId: last.tenantId, pauseId: last.pauseId };
      }

      expect(keys(whole)).toHaveLength(5);
      expect(keys(paged)).toEqual(keys(whole));
      // a keyset past the last pause reads nothing; one before the first reads it all
      const [firstDue] = whole;
      const lastDue = whole.at(-1);
      expect(
        await second.findPendingByExpiresAtBefore(at, 10, {
          at: lastDue?.expiresAt ?? "",
          tenantId: lastDue?.tenantId ?? "",
          pauseId: lastDue?.pauseId ?? "",
        }),
      ).toEqual([]);
      expect(
        keys(
          await second.findPendingByExpiresAtBefore(at, 10, {
            at: firstDue?.expiresAt ?? "",
            tenantId: "",
            pauseId: "",
          }),
        ),
      ).toEqual(keys(whole));
    },
  },
  {
    name: "a limit outside 1–1000 is a RangeError on every scan",
    run: async ({ first }: Instances): Promise<void> => {
      const when = new Date(0);
      for (const limit of [0, 1001, 1.5]) {
        await expect(first.findPendingByExpiresAtBefore(when, limit)).rejects.toBeInstanceOf(
          RangeError,
        );
        await expect(first.findPendingByRemindAtBefore(when, limit)).rejects.toBeInstanceOf(
          RangeError,
        );
        await expect(first.findOpenAfter(undefined, limit)).rejects.toBeInstanceOf(RangeError);
        await expect(first.findClosedByResolvedAtBefore(when, limit)).rejects.toBeInstanceOf(
          RangeError,
        );
      }
      expect(await first.findOpenAfter(undefined, 1)).toEqual({ pauses: [] });
      expect(await first.findOpenAfter(undefined, 1000)).toEqual({ pauses: [] });
    },
  },
  {
    name: "findOpenAfter pages Pending and Resolved, every one once, across tenants; Taken and Cancelled never",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const n of [0, 1, 2, 3, 4])
        await first.findOrCreateByStepKey(dueAt(n, n % 2 === 0 ? "default" : "acme"));
      await first.resolveByTenantIdAndPauseId("acme", "p1", APPROVED_BY_MANAGER, NINE, {
        listeners: [],
      });
      await first.decideByTenantIdAndPauseId("default", "p2", DECIDED_ANSWER, NINE);
      await first.cancelByTenantIdAndPauseId("acme", "p3", PauseResolution.Cancelled, NINE, {
        listeners: [],
      });

      const one = await second.findOpenAfter(undefined, 2);
      const two = await second.findOpenAfter(one.next, 2);

      expect([...ids(one.pauses), ...ids(two.pauses)]).toEqual(["p0", "p1", "p4"]);
      expect(one.next).toBeTypeOf("string");
      expect(two.next).toBeUndefined();
      expect((await second.findOpenAfter(undefined, 1000)).next).toBeUndefined();
    },
  },
  {
    name: "findPageByTenantId filters status, channel and expiresBefore, pages once each, never another tenant's",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const n of [1, 2, 3, 4])
        await first.findOrCreateByStepKey({
          ...dueAt(n),
          channel: n % 2 === 0 ? "other-channel" : "refund-approval-channel",
        });
      await first.findOrCreateByStepKey(dueAt(5, "acme"));
      await first.decideByTenantIdAndPauseId("default", "p4", DECIDED_ANSWER, NINE);
      const page = (
        filter: Parameters<Store["findPageByTenantId"]>[1],
        limit = 10,
        after?: string,
      ) => second.findPageByTenantId("default", filter, limit, after);
      const pending = [PauseStatus.Pending];

      expect(ids((await page({ statuses: pending })).pauses)).toEqual(["p1", "p2", "p3"]);
      expect(ids((await page({ statuses: [PauseStatus.Taken] })).pauses)).toEqual(["p4"]);
      expect(ids((await page({ statuses: pending, channel: "other-channel" })).pauses)).toEqual([
        "p2",
      ]);
      expect(
        ids((await page({ statuses: pending, expiresBefore: new Date(minute(3)) })).pauses),
      ).toEqual(["p1", "p2"]);
      const one = await page({ statuses: pending }, 2);
      const two = await page({ statuses: pending }, 2, one.next);
      expect([...ids(one.pauses), ...ids(two.pauses)]).toEqual(["p1", "p2", "p3"]);
      expect(two.next).toBeUndefined();
      await expect(page({ statuses: [] })).rejects.toBeInstanceOf(TypeError);
    },
  },
  {
    name: "records removed between two pages: the next page skips none",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const n of [0, 1, 2, 3, 4]) await first.findOrCreateByStepKey(dueAt(n));
      for (const n of [0, 1])
        await first.decideByTenantIdAndPauseId("default", `p${String(n)}`, DECIDED_ANSWER, NINE);
      const statuses = [PauseStatus.Pending, PauseStatus.Taken];
      const one = await second.findPageByTenantId("default", { statuses }, 2);

      await first.deleteByResolvedAtBefore(TEN);
      const two = await second.findPageByTenantId("default", { statuses }, 2, one.next);
      const three = await second.findPageByTenantId("default", { statuses }, 2, two.next);

      expect(ids(one.pauses)).toEqual(["p0", "p1"]);
      expect([...ids(two.pauses), ...ids(three.pauses)]).toEqual(["p2", "p3", "p4"]);
    },
  },
  {
    name: "deleteByTenantIdAndThreadIdAndRunId removes that run's paused run only: another run's stays",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.save(pausedRunOf("thread-1", "run-2"));

      await second.deleteByTenantIdAndThreadIdAndRunId("default", "thread-1", "run-1");
      expect((await first.findByTenantIdAndThreadId("default", "thread-1"))?.run.runId).toBe(
        "run-2",
      );

      await second.deleteByTenantIdAndThreadIdAndRunId("default", "thread-1", "run-2");
      expect(await first.findByTenantIdAndThreadId("default", "thread-1")).toBeUndefined();
      await first.deleteByTenantIdAndThreadIdAndRunId("default", "thread-1", "run-2");
    },
  },
];
