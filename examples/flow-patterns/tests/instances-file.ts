import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

/**
 * A SQLite file of its own (`FLOW_PATTERNS_INSTANCES_SQLITE`, what the `instances` environment
 * reads) for each test of the calling file, for `testWith(App, { instances: 2,
 * env: "instances" })` (#550): the instances of one test share it, no other test sees it. A test's
 * ids start again at `thread-1` / `execution-1` (`SequentialIdGenerator`), so a file shared with
 * another test — vitest runs files on one module graph per worker here (`isolate: false`) — would
 * hold other trees under the same ids: their threads, records, leases and fenced effects.
 */
export function instancesFilePerTest(): void {
  const folder = mkdtempSync(join(tmpdir(), "flow-patterns-instances-"));
  let count = 0;
  beforeEach(() => {
    count += 1;
    process.env.FLOW_PATTERNS_INSTANCES_SQLITE = join(folder, `test-${String(count)}.sqlite`);
  });
  afterAll(() => {
    delete process.env.FLOW_PATTERNS_INSTANCES_SQLITE;
    rmSync(folder, { recursive: true, force: true });
  });
}
