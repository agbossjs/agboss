/**
 * #398 PR 2, #481 AC3: `MeshRequestRepository` — the published mesh request contract
 * (`meshRequestContract`), run against the in-memory default (two instances over one database)
 * and `SqliteMeshRequestRepository` (two instances on one file); then the recovery sweep through an
 * application (not a store rule: it stays here).
 */
import { describe, expect } from "vitest";
import {
  InMemoryMeshRequestRepository,
  MeshRequestRepository,
} from "../../src/infrastructure/mesh-request.repository.js";
import { SqliteMeshRequestRepository } from "../../src/infrastructure/sqlite/sqlite-mesh-request.repository.js";
import { meshRequestContract } from "../../src/testing/contracts/index.js";
import { testWith } from "../../src/testing/index.js";
import { minutes, seconds } from "../../src/units/index.js";
import { RemoteDeskApplication } from "../a2a/fixtures/remote.workflow.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

const key = { tenantId: "default", peer: "orders-application", idempotencyKey: "e1:desk:1:call_1" };

describe("#481 AC3: the core's mesh request stores pass the published mesh request contract", () => {
  meshRequestContract(
    inMemoryTarget(({ database }) => new InMemoryMeshRequestRepository(database)),
  );
  meshRequestContract(
    sqliteTarget(({ connection }) => new SqliteMeshRequestRepository(connection())),
  );
});

const test = testWith(RemoteDeskApplication);

describe("#398 PR 2: the recovery sweep removes the answers past their retention", () => {
  test("kept 30 minutes by default, on the application's Clock", async ({ app, clock }) => {
    await app.ready();
    const requests = app.resolve(MeshRequestRepository);
    await requests.saveIfAbsent({ ...key, createdAt: clock.now().toISOString() });

    await clock.advance(minutes(29));
    const kept = await requests.findByKey(key);
    await clock.advance(minutes(1));
    await clock.advance(seconds(31));

    expect(kept).toBeDefined();
    expect(await requests.findByKey(key)).toBeUndefined();
  });
});
