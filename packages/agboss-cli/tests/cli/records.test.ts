/**
 * #401 PR 1 — `agboss records export`: the application's kept root executions as JSON Lines, one
 * masked record per line (`kind: "agboss.execution-record"`), read from its own store without
 * running anything. A tenant is named, or all of them explicitly; an application that keeps no
 * records is `records.not-kept` (exit 3).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComponentKind, ExecutionHistoryStatus, type ExecutionHistoryRecord } from "agboss";
import { openExecutionHistory } from "agboss/internal";
import { SqliteHistoryApplication } from "../../../agboss/tests/infrastructure/sqlite/fixtures/history.application.js";
import { buildCostReport } from "../../../agboss/src/finops/usage.js";
import { agboss, envelope } from "./agboss.js";

const APPLICATION = new URL(
  "../../../agboss/tests/infrastructure/sqlite/fixtures/history.application.ts",
  import.meta.url,
).pathname;
const NOT_KEPT = new URL("../../../agboss/tests/flow/fixtures/evals.fixture.ts", import.meta.url)
  .pathname;

const CWD = mkdtempSync(join(tmpdir(), "agboss-records-"));
const ENV = { AGBOSS_SQLITE_TEST_PATH: join(CWD, "app.db") };
const EXPORT = ["records", "export", "--application", APPLICATION] as const;

/** A kept record of the desk: `tenantId`'s execution `executionId`, started at `startedAt`. */
const recordOf = (
  executionId: string,
  tenantId: string,
  startedAt: string,
): ExecutionHistoryRecord => ({
  path: ["desk-workflow-start", "desk-agent", "desk-workflow-finish"],
  scope: [],
  outdatedValues: [],
  spend: buildCostReport([]),
  children: [],
  pauses: [],
  compensations: [],
  toolCalls: [],
  steps: [],
  executionId,
  rootExecutionId: executionId,
  threadId: `thread-${executionId}`,
  tenantId,
  application: { name: "sqlite-history-application", version: "1.0.0", instanceId: "i-1" },
  workflow: {
    name: "eval-desk-workflow",
    version: "1.0.0",
    startedVersion: "1.0.0",
    configHash: "c",
  },
  status: ExecutionHistoryStatus.Finished,
  startedAt,
  endedAt: startedAt,
  start: {
    name: "desk-workflow-start",
    kind: ComponentKind.WorkflowStart,
    promptHash: undefined,
    schemaHash: undefined,
  },
  input: { text: "Refund order 7 for <email>" },
  contexts: { tenant: { tenantId, plan: "pro" }, execution: { userId: "u-1" } },
});

beforeAll(async () => {
  const opened = await openExecutionHistory(SqliteHistoryApplication, { processEnv: ENV });
  await opened.history.save(recordOf("e1", "acme", "2026-10-16T09:00:00.000Z"));
  await opened.history.save(recordOf("e2", "acme", "2026-10-20T09:00:00.000Z"));
  await opened.history.save(recordOf("e3", "globex", "2026-10-18T09:00:00.000Z"));
  await opened.close();
});

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
});

/** The lines of an exported file, parsed. */
const linesOf = (file: string): Record<string, unknown>[] =>
  readFileSync(join(CWD, file), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("#401 PR 1: agboss records export", () => {
  it("one tenant's records, oldest first, each line marked", async () => {
    const call = await agboss([...EXPORT, "--tenant", "acme", "--out", "acme.jsonl"], CWD, ENV);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain("records: 2 executions (acme) → acme.jsonl");
    const lines = linesOf("acme.jsonl");
    expect(lines.map((line) => [line.kind, line.schema, line.executionId])).toEqual([
      ["agboss.execution-record", 1, "e1"],
      ["agboss.execution-record", 1, "e2"],
    ]);
    expect(lines[0]).toMatchObject({ input: { text: "Refund order 7 for <email>" } });
  });

  it("every tenant's with --all-tenants, a period with --since / --until", async () => {
    const call = await agboss(
      [
        ...EXPORT,
        "--all-tenants",
        "--since",
        "2026-10-17",
        "--until",
        "2026-10-21",
        "--out",
        "all.jsonl",
        "--json",
      ],
      CWD,
      ENV,
    );

    expect(call.code).toBe(0);
    expect(envelope(call)).toMatchObject({
      result: { records: 2, tenantId: null, file: "all.jsonl" },
      created: ["all.jsonl"],
    });
    expect(linesOf("all.jsonl").map((line) => line.executionId)).toEqual(["e3", "e2"]);
  });

  it("a tenant is always named, or all of them — one of the two", async () => {
    const none = await agboss([...EXPORT, "--out", "x.jsonl", "--json"], CWD, ENV);
    const both = await agboss(
      [...EXPORT, "--tenant", "acme", "--all-tenants", "--out", "x.jsonl", "--json"],
      CWD,
      ENV,
    );
    const badDate = await agboss(
      [...EXPORT, "--tenant", "acme", "--since", "last week", "--out", "x.jsonl", "--json"],
      CWD,
      ENV,
    );

    expect([none.code, both.code, badDate.code]).toEqual([2, 2, 2]);
    expect(envelope(none)).toMatchObject({ error: { code: "records.tenant-required" } });
    expect(envelope(both)).toMatchObject({ error: { code: "records.tenant-required" } });
    expect(envelope(badDate)).toMatchObject({ error: { code: "usage.option-value" } });
  });

  it("an application that keeps no records: records.not-kept, exit 3", async () => {
    const call = await agboss(
      [
        "records",
        "export",
        "--application",
        NOT_KEPT,
        "--tenant",
        "acme",
        "--out",
        "x.jsonl",
        "--json",
      ],
      CWD,
    );

    expect(call.code).toBe(3);
    expect(envelope(call)).toMatchObject({
      error: {
        code: "records.not-kept",
        message: expect.stringContaining("executionRecordRetention") as unknown,
      },
    });
  });
});
