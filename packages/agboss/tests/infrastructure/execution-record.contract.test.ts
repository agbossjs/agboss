/**
 * #265 AC7: `ExecutionRecordRepository` — threads and their owners, one record per execution,
 * recovery's paged look-up of `running` roots, and the compare-and-set write (S66 h): a status
 * write lands only while the record still has the expected status, so a late write never replaces
 * what another holder wrote since. One suite, run against the in-memory default and
 * `SqliteExecutionRecordRepository` (two instances on one file).
 */
import { describe, expect, it } from "vitest";
import { ExecutionRecordStatus, type ExecutionRecordRepository } from "../../src/index.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { SqliteExecutionRecordRepository } from "../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import type { NewTern, TernOutcome } from "../../src/terns/index.js";
import { sharedInMemory, storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<ExecutionRecordRepository>({
  inMemory: (seam) =>
    sharedInMemory(
      seam,
      "records",
      () => new InMemoryExecutionRecordRepository(seam.clock, undefined),
    ),
  sqlite: ({ clock, connection }) =>
    new SqliteExecutionRecordRepository(connection(), clock, undefined),
});

/** An outcome with `status`. */
const outcome = (status: ExecutionRecordStatus): TernOutcome => ({
  replyWith: status === ExecutionRecordStatus.Answered ? "Done." : "",
  status,
  stopReason: "",
  route: ["start", "clerk"],
  steps: [],
  costUsd: 0.01,
});

/** A new record of `threadId` with `status`. */
const record = (threadId: string, runId: string, status: ExecutionRecordStatus): NewTern => ({
  ...outcome(status),
  runId,
  threadId,
  tenantId: "default",
  bundle: "desk-workflow",
  task: "where is order 7?",
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: "1.0.0",
  configHash: "hash",
});

describe.each(kinds)("#265 AC7: execution records ($name)", ({ twoInstances }) => {
  it("a thread made on one instance is known to the other, with its owner", async () => {
    const { first, second } = twoInstances();

    const thread = await first.createThread({ workflow: "desk-workflow", tenantId: "default", ownerId: "dana" });

    expect(await second.hasThread("desk-workflow", "default", thread)).toBe(true);
    expect(await second.threadOwner("desk-workflow", "default", thread)).toEqual({ owner: "dana" });
    expect(await second.hasThread("other-workflow", "default", thread)).toBe(false);
  });

  it("the running roots are listed page by page, oldest first", async () => {
    const { first, second } = twoInstances();
    const thread = await first.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const ids: string[] = [];
    for (const runId of ["run-1", "run-2", "run-3"]) {
      ids.push((await first.append(record(thread, runId, ExecutionRecordStatus.Running))).id);
    }
    await first.append(record(thread, "run-4", ExecutionRecordStatus.Answered));

    const page = await second.findByStatus(ExecutionRecordStatus.Running, 2);
    const next = await second.findByStatus(ExecutionRecordStatus.Running, 2, page.at(-1)?.id);

    expect(page.map((item) => item.runId)).toEqual(["run-1", "run-2"]);
    expect(next.map((item) => item.runId)).toEqual(["run-3"]);
    expect((await second.byIds(ids)).map((item) => item.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
  });

  it("compare-and-set: the write lands only from the expected status (S66 h)", async () => {
    const { first, second } = twoInstances();
    const thread = await first.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const { id } = await first.append(record(thread, "run-1", ExecutionRecordStatus.Paused));

    // the holder finished the tree; the resume's `running` write arrives after it
    await first.complete(id, outcome(ExecutionRecordStatus.Answered));
    const late = await second.completeIfStatus(
      id,
      ExecutionRecordStatus.Paused,
      outcome(ExecutionRecordStatus.Running),
    );

    expect(late).toBe(false);
    expect((await first.byIds([id]))[0]?.status).toBe(ExecutionRecordStatus.Answered);
  });

  it("compare-and-set: of two writes from one status exactly one lands", async () => {
    const { first, second } = twoInstances();
    const thread = await first.createThread({ workflow: "desk-workflow", tenantId: "default" });
    const { id } = await first.append(record(thread, "run-1", ExecutionRecordStatus.Paused));

    const landed = await Promise.all([
      first.completeIfStatus(
        id,
        ExecutionRecordStatus.Paused,
        outcome(ExecutionRecordStatus.Running),
      ),
      second.completeIfStatus(
        id,
        ExecutionRecordStatus.Paused,
        outcome(ExecutionRecordStatus.Failed),
      ),
    ]);

    expect(landed.filter(Boolean)).toHaveLength(1);
    expect((await second.byIds([id]))[0]?.status).toBe(ExecutionRecordStatus.Running);
  });
});
