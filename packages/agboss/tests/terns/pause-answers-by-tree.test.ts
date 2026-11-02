/**
 * #676 — the pause answer log keeps one answer per pause of a tree. A file of version 14 keyed it by
 * tenant and step key only; opening it rebuilds the table on (tenant, tree, step key) with every
 * row, its order and its rowid kept, and another tree's answer under the same step key is kept.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteTernStore, openTernDatabase } from "../../src/terns/index.js";

const STEP_KEY = "child-7:refund-agent:1:call-1";

/** A database as version 14 left it: the log keyed by tenant and step key, two answers of a tree. */
async function version14(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "terns-")), "v14.sqlite");
  openTernDatabase(path).close();
  const old = new DatabaseSync(path);
  old.exec(`DROP TABLE pause_answers;
    CREATE TABLE pause_answers (tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
      step_key TEXT NOT NULL, asked_at TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY (tenant_id, step_key));
    CREATE INDEX pause_answers_by_root ON pause_answers(tenant_id, root_execution_id);
    INSERT INTO pause_answers VALUES ('acme', 'old-root', '${STEP_KEY}', '2026-01-05T09:00:00.000Z', 'second asked first');
    INSERT INTO pause_answers VALUES ('acme', 'old-root', 'child-7:refund-agent:1:call-0', '2026-01-05T09:00:00.000Z', 'tie, saved after');
    PRAGMA user_version = 14;`);
  old.close();
  return path;
}

const keyOf = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA index_list(pause_answers)").all() as { name: string }[];
    return rows.map(({ name }) =>
      (db.prepare(`PRAGMA index_info("${name}")`).all() as { name: string }[])
        .map((column) => column.name)
        .join(","),
    );
  } finally {
    db.close();
  }
};

describe("#676: the pause answer log, one answer per pause of a tree", () => {
  it("a file of version 14 is rebuilt by tree, its answers and their order kept", async () => {
    const path = await version14();
    const store = createSqliteTernStore(path, () => new Date());

    await store.appendPauseAnswer({
      tenantId: "acme",
      rootExecutionId: "new-root",
      stepKey: STEP_KEY,
      askedAt: "2026-02-01T09:00:00.000Z",
      record: "another tree's approval",
    });
    await store.appendPauseAnswer({
      tenantId: "acme",
      rootExecutionId: "old-root",
      stepKey: STEP_KEY,
      askedAt: "2026-02-01T09:00:00.000Z",
      record: "the same pause again",
    });

    expect(await store.pauseAnswersOf("acme", "old-root")).toEqual([
      "second asked first",
      "tie, saved after",
    ]);
    expect(await store.pauseAnswersOf("acme", "new-root")).toEqual(["another tree's approval"]);
    store.close();
    expect(keyOf(path).sort()).toEqual([
      "tenant_id,root_execution_id",
      "tenant_id,root_execution_id,step_key",
    ]);
  });
});
