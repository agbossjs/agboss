/**
 * #891 AC2 — a coordination lease store (Redis's) keeps no execution ids of its own: it injects
 * `EXECUTION_ID_STORE`, which the application gives a durable lease store by class —
 * `provide(EXECUTION_ID_STORE, SqliteExecutionLeaseRepository)` — created by the container under
 * that token only: no `new`, no second lease store (`[di.ambiguous-implementation]`), and the
 * one-backend rule still refuses a fenced-effect or outbound-call store beside the coordination leases.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { testWith } from "../../src/testing/index.js";
import { ExecutionLeaseRepository, SqliteExecutionLeaseRepository } from "../../src/index.js";
import {
  CoordinationLeases,
  DURABLE_IDS as durableIds,
  ExecutionIdStoreApplication,
} from "../infrastructure/sqlite/fixtures/execution-id-store.application.js";
import { PostgresEffects, storesApplication } from "./fixtures/store-backends.fixture.js";

async function violationsOf(providers: readonly Provider[]): Promise<readonly string[]> {
  try {
    await applicationOf(storesApplication(providers));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

describe("#891 AC2: provide(EXECUTION_ID_STORE, <a durable lease store>)", () => {
  it("AC2: assembles with the durable lease store under the token — no [di.ambiguous-implementation]", async () => {
    expect(await violationsOf([CoordinationLeases, durableIds])).toEqual([]);
  });

  it("AC2: the same store listed as a second lease store is ambiguous — the token is what avoids it", async () => {
    const found = await violationsOf([CoordinationLeases, SqliteExecutionLeaseRepository]);

    expect(found.join("\n")).toContain("[di.ambiguous-implementation]");
  });

  it("AC2: a fenced-effect store of another backend beside the coordination leases is refused", async () => {
    const found = await violationsOf([CoordinationLeases, durableIds, PostgresEffects]);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("[application.store-backend-mismatch] PostgresEffects");
    expect(found[0]).toContain('CoordinationLeases (backend "redis")');
  });
});

const withDurableIds = testWith(ExecutionIdStoreApplication);

withDurableIds(
  "#891 AC2: at start the token's store is created by the container and keeps the ids",
  async ({ app }) => {
    await app.ready();
    const leases = app.resolve(ExecutionLeaseRepository);
    const identity = { tenantId: "t1", executionId: "e-891" };

    expect(leases).toBeInstanceOf(CoordinationLeases);
    expect(await leases.claimExecutionId(identity)).toBe(true);
    expect(await app.resolve(SqliteExecutionLeaseRepository).claimExecutionId(identity)).toBe(
      false,
    );
  },
);
