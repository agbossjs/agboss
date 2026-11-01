/**
 * #613 — a minted thread id that never finds a free one (an `IdGenerator` stuck on an id the
 * tenant has, or a sequential one restarted on a kept database past 100 of the tenant's threads)
 * fails with `DuplicateThreadIdError` (`run.duplicate-thread-id`: the generator's class and the
 * tries, never an id) — on the in-memory and SQLite record stores, at `execute`, before any thread,
 * record, lease or checkpoint of the refused call is written.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateThreadIdError } from "../../src/errors.js";
import { CheckedIdGenerator, IdGenerator } from "../../src/infrastructure/clock.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { systemClock } from "../../src/infrastructure/clock.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { minting, resetMinting } from "../infrastructure/fixtures/minted-ids.application.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { SqlitePlannedIdsApplication } from "../infrastructure/sqlite/fixtures/sqlite-minted-ids.application.js";

const file = sqliteFilePerTest();
const sqlite = testWith(SqlitePlannedIdsApplication);

beforeEach(() => {
  resetMinting();
  resetRecovery();
});

const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

/** A generator stuck on one id. */
class StuckIdGenerator extends IdGenerator {
  newThreadId(): string {
    return "thread-taken";
  }

  newExecutionId(): string {
    return "execution-1";
  }
}

/** The refusal names the generator and the tries, never the id. */
function expectExhausted(error: unknown, generator: string): void {
  expect(error).toBeInstanceOf(DuplicateThreadIdError);
  expect(error).toMatchObject({ code: "run.duplicate-thread-id", generator, tries: 100 });
  expect((error as Error).message).toContain(`${generator}.newThreadId()`);
  expect((error as Error).message).not.toContain("thread-taken");
  expect(JSON.stringify((error as DuplicateThreadIdError).details)).not.toContain("thread-taken");
}

/** The rows of every table of the test's SQLite file. */
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

describe("#613: a minted thread id that never finds a free one", () => {
  it.each([
    ["the project's own generator", new StuckIdGenerator()],
    ["the framework's check around it", new CheckedIdGenerator(new StuckIdGenerator())],
  ])(
    "the in-memory record store refuses with DuplicateThreadIdError, through %s",
    async (_, generator) => {
      const store = new InMemoryExecutionRecordRepository(systemClock, generator);
      const thread = { workflow: "desk-workflow", tenantId: "default" };
      await store.createThread({ ...thread, threadId: "thread-taken" });

      const refused = await rejectionOf(store.createThread(thread));

      expectExhausted(refused, "StuckIdGenerator");
    },
  );

  sqlite(
    "execute on SQLite: refused after 100 taken ids, nothing of the refused call on the file but its kept execution id and budgets",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      await execute(app, OrderWorkflowStart, { text: "a" }, { threadId: "thread-taken" });
      const before = rowsOnFile();
      minting.threads = Array.from({ length: 100 }, () => "thread-taken");

      const refused = await rejectionOf(execute(app, OrderWorkflowStart, { text: "b" }));

      expectExhausted(refused, "PlannedIdGenerator");
      expect(minting.threads).toEqual([]);
      const { cost_ledger_max_spend: _spend, execution_ids: ids, ...rest } = rowsOnFile();
      const {
        cost_ledger_max_spend: _spendBefore,
        execution_ids: idsBefore,
        ...restBefore
      } = before;
      expect(rest).toEqual(restBefore);
      expect([idsBefore, ids]).toEqual([1, 2]);
    },
  );
});
