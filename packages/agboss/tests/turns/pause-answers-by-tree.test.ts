/**
 * #676 — the pause answer log keeps one answer per pause of a tree: it is keyed by (tenant, tree,
 * step key), so another tree's answer under the same step key is kept, with every row's order.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteTurnStore, openTurnDatabase } from "../../src/turns/index.js";

const STEP_KEY = "child-7:refund-agent:1:call-1";

/** A database file with two answers of a tree in the log. */
async function withTwoAnswers(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "terns-")), "answers.sqlite");
  openTurnDatabase(path).close();
  const old = new DatabaseSync(path);
  old.exec(`INSERT INTO pause_answers VALUES ('acme', 'old-root', '${STEP_KEY}', '2026-01-05T09:00:00.000Z', 'second asked first');
    INSERT INTO pause_answers VALUES ('acme', 'old-root', 'child-7:refund-agent:1:call-0', '2026-01-05T09:00:00.000Z', 'tie, saved after');`);
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
  it("a pause of another tree under the same step key is kept, the answers in their order", async () => {
    const path = await withTwoAnswers();
    const store = createSqliteTurnStore(path, () => new Date());

    await store.appendPauseAnswer({
      tenantId: "acme",
      rootExecutionId: "new-root",
      stepKey: STEP_KEY,
      askedAt: new Date("2026-02-01T09:00:00.000Z"),
      record: "another tree's approval",
    });
    await store.appendPauseAnswer({
      tenantId: "acme",
      rootExecutionId: "old-root",
      stepKey: STEP_KEY,
      askedAt: new Date("2026-02-01T09:00:00.000Z"),
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
