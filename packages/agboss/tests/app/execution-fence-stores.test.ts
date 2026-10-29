/**
 * #471 AC2, AC5 — fencing over real stores: the external ledger in SQLite (its own file, each
 * instance its own connection) checks `token >= highest` by `scopeKey` and the idempotency key in
 * one transaction; `leases.stall` freezes an instance whatever lease store the application lists —
 * AGBoss's SQLite stores on one file, or a project's own `ExecutionLeaseRepository`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionFencedError } from "../../src/index.js";
import { override, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { resetRecovery, seen as recovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  ArtifactLedger,
  ledger,
  levers,
  ReleaseWorkflowStart,
  resetFence,
  seen,
  Staged,
} from "./fixtures/fence.workflow.js";
import {
  CountedExecutionLeaseRepository,
  external,
  externalRows,
  FenceOwnLeasesApplication,
  FenceSqliteApplication,
  SqliteArtifactLedger,
} from "../infrastructure/sqlite/fixtures/fence-stores.application.js";
import { instance, rejectionOf, settle, takenOver } from "./fixtures/fence-takeover.js";

sqliteFilePerTest();
const folder = mkdtempSync(join(tmpdir(), "agboss-fence-ledger-"));
const sqliteLedger = [override(ArtifactLedger, SqliteArtifactLedger)];

beforeEach(() => {
  resetFence();
  resetRecovery();
  CountedExecutionLeaseRepository.calls = 0;
  external.path = join(folder, `ledger-${String(Date.now())}-${String(Math.random())}.sqlite`);
});

afterEach(() => {
  levers.letGo?.();
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("#471 AC2: one transaction — the fence and the idempotency key", () => {
  const test = testWith(FenceSqliteApplication, { overrides: sqliteLedger });

  test("a release writes its row and raises the scope's mark; the same key again is deduplicated", async ({
    app,
  }) => {
    const result = await execute(app, ReleaseWorkflowStart, { text: "v1" });

    expect(result.output).toEqual({ text: Staged.Written });
    const rows = externalRows();
    expect(rows).toEqual([
      {
        scopeKey: `default:${result.executionId}`,
        token: 1,
        idempotencyKey: `${result.executionId}:release-action:1`,
        artifact: "v1",
      },
    ]);
    const replay = new SqliteArtifactLedger().stage({ ...rows[0], token: 1 } as never);
    expect(replay).toBe(Staged.Deduplicated);
    expect(() => new SqliteArtifactLedger().stage({ ...rows[0], token: 0 } as never)).toThrow(
      ExecutionFencedError,
    );
    expect(externalRows()).toHaveLength(1);
  });
});

describe.each([
  { name: "AGBoss's SQLite stores", application: FenceSqliteApplication },
  { name: "a project's own lease store", application: FenceOwnLeasesApplication },
])("#471 AC3 / AC5: a stalled writer over $name", ({ application }) => {
  const two = testWith(application, { instances: 2, overrides: sqliteLedger });

  two(
    "its write after the takeover is refused in the ledger's transaction; one row, B's",
    async ({ apps, clock, leases }) => {
      const { call } = await takenOver(apps, clock, leases);

      levers.letGo?.();
      await settle();
      leases.resume(instance(apps, 0));
      const error = await rejectionOf(call);

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(error).toMatchObject({ token: 1, observedToken: 2 });
      expect(externalRows().map((row) => row.token)).toEqual([2]);
      expect(ledger.refused.map((row) => row.token)).toEqual([1]);
      expect(seen.fences.map((each) => each.token)).toEqual([1, 2]);
      expect(recovery.errors).toEqual([]);
      if (application === FenceOwnLeasesApplication)
        expect(CountedExecutionLeaseRepository.calls).toBeGreaterThan(0);
    },
  );
});
