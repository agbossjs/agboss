/**
 * #398 PR 2: `MeshRequestRepository` — the trusted mesh requests' answers by their key. One save of
 * a key wins, even on two instances; a key is scoped by tenant and peer; an answer is kept, a
 * request without one forgotten; the sweep removes what is older than its cutoff. One suite, run
 * against the in-memory default (two instances over one database) and `SqliteMeshRequestRepository`
 * (two instances on one file).
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryMeshRequestRepository,
  MeshRequestRepository,
} from "../../src/infrastructure/mesh-request.repository.js";
import { testWith } from "../../src/testing/index.js";
import { minutes, seconds } from "../../src/units/index.js";
import { RemoteDeskApplication } from "../a2a/fixtures/remote.workflow.js";
import { SqliteMeshRequestRepository } from "../../src/infrastructure/sqlite/sqlite-mesh-request.repository.js";
import { storeKinds } from "./contracts/store-kinds.js";

const key = { tenantId: "default", peer: "orders-application", idempotencyKey: "e1:desk:1:call_1" };
const at = (iso: string) => ({ ...key, createdAt: iso });

const kinds = storeKinds<MeshRequestRepository>({
  inMemory: ({ database }) => new InMemoryMeshRequestRepository(database),
  sqlite: ({ connection }) => new SqliteMeshRequestRepository(connection()),
});

describe.each(kinds)("#398 PR 2: MeshRequestRepository ($name)", ({ twoInstances }) => {
  it("one save of a key wins, on two instances", async () => {
    const { first, second } = twoInstances();

    const saved = await Promise.all([
      first.saveIfAbsent(at("2026-01-05T09:00:00.000Z")),
      second.saveIfAbsent(at("2026-01-05T09:00:00.000Z")),
    ]);

    expect(saved.filter(Boolean)).toHaveLength(1);
    expect(await second.findByKey(key)).toEqual(at("2026-01-05T09:00:00.000Z"));
  });

  it("a key is the tenant's and the peer's: another one finds nothing", async () => {
    const { first, second } = twoInstances();
    await first.saveIfAbsent(at("2026-01-05T09:00:00.000Z"));

    expect(await second.findByKey({ ...key, peer: "elsewhere-application" })).toBeUndefined();
    expect(await second.findByKey({ ...key, tenantId: "acme" })).toBeUndefined();
  });

  it("an answer is kept for the key; a request without one is forgotten", async () => {
    const { first, second } = twoInstances();
    const other = { ...key, idempotencyKey: "e1:desk:1:call_2" };
    await first.saveIfAbsent(at("2026-01-05T09:00:00.000Z"));
    await first.saveIfAbsent({ ...other, createdAt: "2026-01-05T09:00:00.000Z" });

    await first.saveResponse(key, { status: "finished", output: { text: "paid" } });
    await first.deleteByKey(other);

    expect((await second.findByKey(key))?.response).toEqual({
      status: "finished",
      output: { text: "paid" },
    });
    expect(await second.findByKey(other)).toBeUndefined();
    expect(await second.saveIfAbsent({ ...other, createdAt: "2026-01-05T09:01:00.000Z" })).toBe(
      true,
    );
  });

  it("the sweep removes the requests admitted before its cutoff only", async () => {
    const { first, second } = twoInstances();
    const late = { ...key, idempotencyKey: "late" };
    await first.saveIfAbsent(at("2026-01-05T09:00:00.000Z"));
    await first.saveIfAbsent({ ...late, createdAt: "2026-01-05T09:40:00.000Z" });

    await second.deleteCreatedBefore(new Date("2026-01-05T09:30:00.000Z"));

    expect(await first.findByKey(key)).toBeUndefined();
    expect(await first.findByKey(late)).toBeDefined();
  });
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
