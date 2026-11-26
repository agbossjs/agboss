/**
 * #1307e L4: the SQLite assignee filter reads `pause_assignees`, a table its triggers keep equal to
 * the `assignees` of each pause's JSON through insert, change and delete.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureBaselineSchema } from "../../src/infrastructure/sqlite/sqlite-baseline-schema.js";

const open = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  ensureBaselineSchema(database);
  return database;
};

const insert = (database: DatabaseSync, id: string, body: string): number =>
  Number(
    database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('t', ?, ?, 'r', 'pending', 0, ?)",
      )
      .run(id, `k-${id}`, body).lastInsertRowid,
  );

const rows = (database: DatabaseSync): readonly string[] =>
  database
    .prepare("SELECT assignee || ':' || seq AS row FROM pause_assignees ORDER BY assignee, seq")
    .all()
    .map((row) => String((row as { row: unknown }).row));

describe("#1307e L4: pause_assignees follows the pauses' JSON", () => {
  it("insert adds a row per text assignee; none for a missing, malformed or non-text list", () => {
    const database = open();
    const one = insert(database, "p1", JSON.stringify({ assignees: ["ann", "bob", "ann"] }));
    insert(database, "p2", "{}");
    insert(database, "p3", "not json");
    insert(database, "p4", JSON.stringify({ assignees: [1, null] }));

    expect(rows(database)).toEqual([`ann:${String(one)}`, `bob:${String(one)}`]);
  });

  it("a change of the pause replaces its rows; a delete removes them", () => {
    const database = open();
    const seq = insert(database, "p1", JSON.stringify({ assignees: ["ann", "bob"] }));
    const other = insert(database, "p2", JSON.stringify({ assignees: ["bob"] }));

    database
      .prepare("UPDATE pauses SET pause = ? WHERE pause_id = 'p1'")
      .run(JSON.stringify({ assignees: ["cy"] }));
    expect(rows(database)).toEqual([`bob:${String(other)}`, `cy:${String(seq)}`]);

    database.prepare("UPDATE pauses SET status = 'taken' WHERE pause_id = 'p2'").run();
    expect(rows(database)).toEqual([`bob:${String(other)}`, `cy:${String(seq)}`]);

    database.prepare("DELETE FROM pauses WHERE pause_id = 'p1'").run();
    expect(rows(database)).toEqual([`bob:${String(other)}`]);
  });

  it("the assignee filter's lookup is on the primary key, not a scan of the pauses' JSON", () => {
    const database = open();
    const plan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT p.* FROM pauses p WHERE p.seq > 0 AND p.seq IN (SELECT seq FROM pause_assignees WHERE assignee = ?) ORDER BY p.seq LIMIT 5",
      )
      .all("ann")
      .map((row) => String((row as { detail: unknown }).detail))
      .join("\n");

    expect(plan).toMatch(/pause_assignees/);
    expect(plan).toMatch(/PRIMARY KEY|sqlite_autoindex|USING (COVERING )?INDEX/);
  });
});
