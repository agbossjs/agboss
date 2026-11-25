/**
 * #591 on SQLite — the ids handed out live in the file (`execution_ids`): a repeated root id is
 * refused with nothing written, two instances on one file minting one id at once run one tree, and
 * a tree's id is kept for good once it is handed out.
 */
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
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

describe("#591 on SQLite", () => {
  test("a repeated root id is refused with nothing written to the file", async ({
    app,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
    minting.executions = ["order-tree-7", "order-tree-7"];
    const first = await execute(app, OrderWorkflowStart, { text: "a" });
    const before = rowsOnFile();

    const refused = await rejectionOf(execute(app, OrderWorkflowStart, { text: "b" }));

    expect(first.status).toBe(ExecutionStatus.Finished);
    expect(refused).toBeInstanceOf(ExecutionError.DuplicateExecutionId);
    expect(rowsOnFile()).toEqual(before);
    expect(before.execution_ids).toBe(1);
  });

  twice(
    "two instances on one file minting one id at once: one tree runs, the other is refused",
    async ({ apps, mockModel }) => {
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances expected");
      mockModel(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      minting.executions = ["same-id", "same-id"];

      const outcomes = await Promise.all([
        rejectionOf(execute(first, OrderWorkflowStart, { text: "a" })),
        rejectionOf(execute(second, OrderWorkflowStart, { text: "b" })),
      ]);

      expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome !== undefined)).toBeInstanceOf(
        ExecutionError.DuplicateExecutionId,
      );
    },
  );
});
