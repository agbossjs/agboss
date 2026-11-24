import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  ExecutionTreeRepository,
  type ExecutionTree,
  type ExecutionTreeValue,
} from "../execution-tree.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { parsedStoredJson } from "../stored-step.js";

/** A stored value as JSON gives it back: what `saveIfAbsentInTree` wrote. */
const TreeValue: z.ZodType<ExecutionTreeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(TreeValue),
    z.record(z.string(), TreeValue),
  ]),
);

const ValueRow = z.object({ value: z.string() });

/**
 * `ExecutionTreeRepository` on the application's SQLite file (#265, S32): one row per key of a
 * tree, the value as JSON. `saveIfAbsentInTree` is one `INSERT OR IGNORE` in a `BEGIN IMMEDIATE`
 * transaction, so of two instances on one file saving one key exactly one gets `true`. Listed in
 * `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteExecutionTreeRepository extends ExecutionTreeRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsentInTree(
    tree: ExecutionTree,
    key: string,
    value: ExecutionTreeValue,
  ): Promise<boolean> {
    const json = JSON.stringify(value);
    const saved = this.connection.transaction(() => {
      const { changes } = this.connection.database
        .prepare("INSERT OR IGNORE INTO execution_tree_keys VALUES (?, ?, ?, ?)")
        .run(tree.tenantId, tree.rootExecutionId, key, json);
      return Number(changes) === 1;
    });
    return Promise.resolve(saved);
  }

  findByIdInTree(tree: ExecutionTree, key: string): Promise<ExecutionTreeValue | undefined> {
    const row = this.connection.database
      .prepare(
        `SELECT value FROM execution_tree_keys WHERE tenant_id = ? AND root_execution_id = ?
         AND tree_key = ?`,
      )
      .get(tree.tenantId, tree.rootExecutionId, key);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve(
      TreeValue.parse(
        parsedStoredJson({
          what: "execution tree value",
          text: ValueRow.parse(row).value,
          ids: { key },
        }),
      ),
    );
  }

  deleteAllInTree(tree: ExecutionTree): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM execution_tree_keys WHERE tenant_id = ? AND root_execution_id = ?")
      .run(tree.tenantId, tree.rootExecutionId);
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteExecutionTreeRepository);
