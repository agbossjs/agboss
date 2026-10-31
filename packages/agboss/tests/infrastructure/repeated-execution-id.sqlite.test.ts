/**
 * #591 on SQLite — the ids handed out live in the file (`execution_ids`): a repeated root id is
 * refused with nothing written, two instances on one file minting one id at once run one tree, and
 * a file an older version wrote knows its trees' ids from their leases.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { DuplicateExecutionIdError } from "../../src/errors.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
} from "./fixtures/recovery.workflow.js";
import { minting, resetMinting } from "./fixtures/minted-ids.application.js";
import { sqliteFilePerTest } from "./sqlite/fixtures/sqlite.workflow.js";
import { SqlitePlannedIdsApplication } from "./sqlite/fixtures/sqlite-minted-ids.application.js";

const file = sqliteFilePerTest();
const test = testWith(SqlitePlannedIdsApplication);
const twice = testWith(SqlitePlannedIdsApplication, { instances: 2 });

beforeEach(() => {
  resetMinting();
  resetRecovery();
});

const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The rows of every table of the test's file. */
function rowsOnFile(): Record<string, number> {
  const database = new DatabaseSync(file.path, { readOnly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => {
        const row = database.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number };
        return [name, row.n];
      }),
    );
  } finally {
    database.close();
  }
}

/** A file as a version before #591 left it: one tree's lease, no table of ids. */
function fileOfAnOlderVersion(rootExecutionId: string): void {
  const database = new DatabaseSync(file.path);
  try {
    database.exec(`CREATE TABLE execution_leases (
      tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
      yielded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, root_execution_id));`);
    database
      .prepare("INSERT INTO execution_leases VALUES ('acme', ?, 'instance-0', 4, 0, 3, 0)")
      .run(rootExecutionId);
  } finally {
    database.close();
  }
}

describe("#591 on SQLite", () => {
  test("a repeated root id is refused with nothing written to the file", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
    minting.executions = ["order-tree-7", "order-tree-7"];
    const first = await execute(app, OrderWorkflowStart, { text: "a" });
    const before = rowsOnFile();

    const refused = await rejectionOf(execute(app, OrderWorkflowStart, { text: "b" }));

    expect(first.status).toBe(ExecutionStatus.Finished);
    expect(refused).toBeInstanceOf(DuplicateExecutionIdError);
    expect(rowsOnFile()).toEqual(before);
    expect(before.execution_ids).toBe(1);
  });

  twice(
    "two instances on one file minting one id at once: one tree runs, the other is refused",
    async ({ apps, mockLlm }) => {
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances expected");
      mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      minting.executions = ["same-id", "same-id"];

      const outcomes = await Promise.all([
        rejectionOf(execute(first, OrderWorkflowStart, { text: "a" })),
        rejectionOf(execute(second, OrderWorkflowStart, { text: "b" })),
      ]);

      expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome !== undefined)).toBeInstanceOf(
        DuplicateExecutionIdError,
      );
    },
  );

  test("a file of an older version: its trees' ids come from their leases, of any tenant", async ({
    app,
  }) => {
    fileOfAnOlderVersion("old-root");
    minting.executions = ["old-root"];

    const refused = await rejectionOf(execute(app, OrderWorkflowStart, { text: "a" }));

    expect(refused).toBeInstanceOf(DuplicateExecutionIdError);
  });
});
