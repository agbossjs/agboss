import { expect } from "vitest";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import { PauseResolution } from "../../infrastructure/pause-record.js";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { expiringPauseOf, TEN } from "./paused-execution-data.js";

/** #935: a page's cursor is a monotonic insertion sequence, never a position — no number is given twice. */
type Instances = ContractInstances<PausedExecutionRepository>;
const ids = (pauses: readonly PauseRecord[]): readonly string[] =>
  pauses.map((pause) => pause.pauseId);
const statuses = [PauseStatus.Pending, PauseStatus.Cancelled];

export const CURSOR_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "#935 page 1, the cursor row and every later one deleted, a pause inserted: the old cursor returns it (findPageByTenantId and findOpenAfter)",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const n of [1, 2, 3])
        await first.findOrCreateByStepKey(
          expiringPauseOf(`p${String(n)}`, `run-1:s:1:${String(n)}`),
        );
      const one = await second.findPageByTenantId("default", { statuses }, 2);
      const open = await second.findOpenAfter(undefined, 2);
      for (const id of ["p2", "p3"])
        await first.cancelByTenantIdAndPauseId(
          "default",
          id,
          PauseResolution.Cancelled,
          new Date("2020-01-01T00:00:00.000Z"),
          NO_RECIPIENTS,
        );
      await first.deleteByResolvedAtBefore(TEN);
      await first.findOrCreateByStepKey(expiringPauseOf("p4", "run-1:s:1:4"));

      const two = await second.findPageByTenantId("default", { statuses }, 2, one.next);
      const openTwo = await second.findOpenAfter(open.next, 2);

      expect(ids(one.pauses)).toEqual(["p1", "p2"]);
      expect(ids(two.pauses)).toEqual(["p4"]);
      expect(ids(openTwo.pauses)).toEqual(["p4"]);
    },
  },
];
