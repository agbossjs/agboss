/**
 * #401 PR 1 — what `agboss records export` is built on: the application's history opened without
 * running anything (`openExecutionHistory`), its records read page by page (`historyRecordsOf`)
 * and written one marked line each (`exportedRecordLine`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openExecutionHistory } from "../../src/application/execution-history-store.js";
import {
  EXECUTION_RECORD_KIND,
  exportedRecordLine,
  historyRecordsOf,
} from "../../src/infrastructure/execution-history-export.js";
import {
  ExecutionHistoryStatus,
  InMemoryExecutionHistoryRepository,
  type ExecutionHistoryRecord,
} from "../../src/infrastructure/execution-history.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { buildCostReport } from "../../src/finops/usage.js";
import { bareRecordOf, ComponentKind } from "../../src/flow/runtime/records.js";
import { EvalDeskApplication } from "../flow/fixtures/eval-desk.fixture.js";
import { SqliteHistoryApplication } from "./sqlite/fixtures/history.application.js";

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** The `n`-th record of a tenant, started `n` seconds after the test's start. */
const recordOf = (n: number, tenantId = "acme"): ExecutionHistoryRecord => ({
  path: [],
  scope: [],
  outdatedValues: [],
  spend: buildCostReport([]),
  children: [],
  pauses: [],
  compensations: [],
  toolCalls: [],
  steps: [],
  executionId: `e${String(n).padStart(4, "0")}`,
  rootExecutionId: `e${String(n).padStart(4, "0")}`,
  threadId: "thread-1",
  tenantId,
  application: { name: "desk-application", version: "1.0.0", instanceId: "i-1" },
  workflow: { name: "desk-workflow", version: "1.0.0", startedVersion: "1.0.0", configHash: "c" },
  status: ExecutionHistoryStatus.Finished,
  startedAt: new Date(Date.UTC(2026, 0, 5, 9, 0, n)).toISOString(),
  start: bareRecordOf("desk-workflow-start", ComponentKind.WorkflowStart),
  input: { text: "hi" },
  contexts: { tenant: { tenantId }, execution: {} },
});

const ALWAYS = { from: new Date(0), to: new Date("2100-01-01T00:00:00.000Z") };

describe("#401 PR 1: the export of kept executions", () => {
  it("every record of a query, across pages, oldest first; one tenant's or every tenant's", async () => {
    const history = new InMemoryExecutionHistoryRepository(new InMemoryDatabase());
    for (let n = 0; n < 501; n += 1) await history.save(recordOf(n));
    await history.save(recordOf(600, "globex"));

    const read = async (tenantId: string | undefined): Promise<string[]> => {
      const ids: string[] = [];
      for await (const record of historyRecordsOf(history, { tenantId, ...ALWAYS }))
        ids.push(record.executionId);
      return ids;
    };

    const acme = await read("acme");
    expect(acme).toHaveLength(501);
    expect(acme.at(-1)).toBe("e0500");
    expect(await read(undefined)).toHaveLength(502);
  });

  it("one line per record: the marker, the schema, then the record", () => {
    const line = JSON.parse(exportedRecordLine(recordOf(1))) as Record<string, unknown>;

    expect(line).toMatchObject({ kind: EXECUTION_RECORD_KIND, schema: 1, executionId: "e0001" });
  });

  it("opens the application's stores only: kept or not, on its SQLite file", async () => {
    const folder = mkdtempSync(join(tmpdir(), "agboss-history-"));
    folders.push(folder);
    const processEnv = { AGBOSS_SQLITE_TEST_PATH: join(folder, "app.db") };
    const writer = await openExecutionHistory(SqliteHistoryApplication, { processEnv });
    await writer.history.save(recordOf(1));
    await writer.close();

    const reader = await openExecutionHistory(SqliteHistoryApplication, { processEnv });
    const notKept = await openExecutionHistory(EvalDeskApplication);

    expect(reader).toMatchObject({ application: "sqlite-history-application", isKept: true });
    expect(await reader.history.findAllByExecutionId("e0001")).toHaveLength(1);
    expect(notKept.isKept).toBe(false);
    await reader.close();
    await notKept.close();
  });
});
