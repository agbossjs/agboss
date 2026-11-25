import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

/**
 * A SQLite file of its own (`AGBOSS_SQLITE_PATH`, what the application's storage reads in place
 * of `:memory:`) for each test of the calling file, for `testWith(App, { instances: 2 })` (#550): the instances of one test share it, no other test sees it. A test's
 * ids start again at `thread-1` / `execution-1` (`SequentialIdGenerator`), so a file shared with
 * another test — vitest runs files on one module graph per worker here (`isolate: false`) — would
 * hold other trees under the same ids: their threads, records, leases and fenced effects.
 */
export function instancesFilePerTest(): void {
  const folder = mkdtempSync(join(tmpdir(), "flow-patterns-instances-"));
  let count = 0;
  beforeEach(() => {
    count += 1;
    process.env.AGBOSS_SQLITE_PATH = join(folder, `test-${String(count)}.sqlite`);
  });
  afterAll(() => {
    process.env.AGBOSS_SQLITE_PATH = ":memory:";
    rmSync(folder, { recursive: true, force: true });
  });
}
