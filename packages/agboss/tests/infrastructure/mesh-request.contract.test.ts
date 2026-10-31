/**
 * #398 PR 2: `MeshRequestRepository`'s recovery sweep through an application (not a store rule: it
 * stays here). The published mesh request contract runs on the core's stores through
 * `storeConformance` (#526, store-conformance.*.test.ts).
 */
import { describe, expect } from "vitest";
import { MeshRequestRepository } from "../../src/infrastructure/mesh-request.repository.js";
import { testWith } from "../../src/testing/index.js";
import { minutes, seconds } from "../../src/units/index.js";
import { RemoteDeskApplication } from "../a2a/fixtures/remote.workflow.js";

const key = { tenantId: "default", peer: "orders-application", idempotencyKey: "e1:desk:1:call_1" };

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
