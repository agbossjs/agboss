import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import type { FaultSuiteOptions } from "../../src/testing/faults/index.js";

/**
 * #484 — the core's SQLite target of the fault suite: one file per test file, a fresh one before
 * each scenario (its rows gone), every pod's clock ten times faster than real time (a lease lasts
 * 3 s, the sweep comes every 3 s) — the suite runs on the real clock in agbossjs/postgres.
 */

/** The store set's module: every SQLite store on one file. */
export const SQLITE_FAULT_STORES = fileURLToPath(
  new URL("./sqlite.fault-stores.ts", import.meta.url),
);

/** The time scale of the core's own runs. */
export const SQLITE_TIME_SCALE = 10;

/** The fault suite's options on a file of this test file's own. */
export function sqliteFaultTarget(
  stores: string = SQLITE_FAULT_STORES,
): Omit<FaultSuiteOptions, "scenarios"> {
  const dir = mkdtempSync(join(tmpdir(), "agboss-faults-"));
  let runs = 0;
  let file = join(dir, "faults-0.sqlite");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    name: "SQLite",
    stores,
    timeScale: SQLITE_TIME_SCALE,
    database: {
      get url() {
        return file;
      },
      reset: () => {
        runs += 1;
        file = join(dir, `faults-${String(runs)}.sqlite`);
      },
    },
  };
}
