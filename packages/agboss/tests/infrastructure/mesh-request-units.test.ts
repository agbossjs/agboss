/**
 * #1374 (shard once-mesh) — the mesh request stores' own decisions, which a trusted MCP call that runs once
 * stands on (`dedupedMcpCall`, #1366): `saveIfAbsent` is the once-only claim — on SQLite one `INSERT OR IGNORE` and
 * its changes count, in memory `has` and `set` — and nothing stands behind it, no lease. Each rule on both stores:
 * the claim is the key's, a repeat is refused and keeps the first row, an answer and a delete reach that key only,
 * the sweep removes what was admitted before its cutoff and not at it, and a store keeps a copy.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  InMemoryMeshRequestRepository,
  MeshRequestRepository,
  meshRequestKeyOf,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "../../src/infrastructure/mesh-request.repository.js";
import { SqliteMeshRequestRepository } from "../../src/infrastructure/sqlite/sqlite-mesh-request.repository.js";
import { isSqliteImplementation } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const KEY: MeshRequestKey = {
  tenantId: "acme",
  peer: "orders-application",
  idempotencyKey: "call_1",
};
const NINE = "2026-01-05T09:00:00.000Z";
const at = (createdAt: string, key: MeshRequestKey = KEY): MeshRequestRecord => ({
  ...key,
  tool: "order-status-tool",
  requestHash: "sha256:aa",
  createdAt,
  expiresAt: new Date(Date.parse(createdAt) + 30 * 60_000).toISOString(),
});

const stores: readonly (readonly [string, () => MeshRequestRepository])[] = [
  ["in memory", () => new InMemoryMeshRequestRepository(new InMemoryDatabase())],
  ["SQLite", () => new SqliteMeshRequestRepository(connectionTo(temporarySqlitePath()))],
];

describe.each(stores)("#1374: the mesh request store %s", (_kind, make) => {
  it("pings", async () => {
    await expect(make().ping()).resolves.toBeUndefined();
  });

  it("claims a key once: the first save wins, a repeat is refused and the first row stays", async () => {
    const store = make();

    expect(await store.saveIfAbsent(at(NINE))).toBe(true);
    expect(await store.saveIfAbsent(at("2026-01-05T10:00:00.000Z"))).toBe(false);
    expect(await store.saveIfAbsent(at("2026-01-05T11:00:00.000Z"))).toBe(false);

    expect(await store.findByKey(KEY)).toEqual(at(NINE));
  });

  it("claims each part of the key apart: another tenant, another peer, another call id is a new claim", async () => {
    const store = make();
    await store.saveIfAbsent(at(NINE));

    expect(await store.saveIfAbsent(at(NINE, { ...KEY, tenantId: "other" }))).toBe(true);
    expect(await store.saveIfAbsent(at(NINE, { ...KEY, peer: "other-application" }))).toBe(true);
    expect(await store.saveIfAbsent(at(NINE, { ...KEY, idempotencyKey: "call_2" }))).toBe(true);
    expect(await store.saveIfAbsent(at(NINE))).toBe(false);
  });

  it("finds nothing for a key it does not hold, and a saved request has no answer yet", async () => {
    const store = make();

    expect(await store.findByKey(KEY)).toBeUndefined();
    await store.saveIfAbsent(at(NINE));

    const found = await store.findByKey(KEY);
    expect(found).toEqual(at(NINE));
    expect(found).not.toHaveProperty("response");
  });

  it("keeps an answer for its key only, a falsy one as well", async () => {
    const store = make();
    const other = { ...KEY, idempotencyKey: "call_2" };
    await store.saveIfAbsent(at(NINE));
    await store.saveIfAbsent(at(NINE, other));

    await store.saveResponse(KEY, { status: "finished", output: { text: "paid" } });

    expect((await store.findByKey(KEY))?.response).toEqual({
      status: "finished",
      output: { text: "paid" },
    });
    expect(await store.findByKey(other)).not.toHaveProperty("response");
    await store.saveResponse(other, 0);
    expect((await store.findByKey(other))?.response).toBe(0);
  });

  it("keeps an answer for the tenant and the peer that asked, not for another's", async () => {
    const store = make();
    const otherTenant = { ...KEY, tenantId: "other" };
    const otherPeer = { ...KEY, peer: "other-application" };
    await store.saveIfAbsent(at(NINE));
    await store.saveIfAbsent(at(NINE, otherTenant));
    await store.saveIfAbsent(at(NINE, otherPeer));

    await store.saveResponse(KEY, { answer: 1 });

    expect(await store.findByKey(otherTenant)).not.toHaveProperty("response");
    expect(await store.findByKey(otherPeer)).not.toHaveProperty("response");
  });

  it("saves the answer of a key it does not hold nowhere", async () => {
    const store = make();

    await store.saveResponse(KEY, { answer: 1 });

    expect(await store.findByKey(KEY)).toBeUndefined();
    expect(await store.saveIfAbsent(at(NINE))).toBe(true);
    expect(await store.findByKey(KEY)).not.toHaveProperty("response");
  });

  it("forgets a request by its whole key, and its caller may claim the key again", async () => {
    const store = make();
    const others = [
      { ...KEY, tenantId: "other" },
      { ...KEY, peer: "other-application" },
      { ...KEY, idempotencyKey: "call_2" },
    ];
    await store.saveIfAbsent(at(NINE));
    for (const other of others) await store.saveIfAbsent(at(NINE, other));

    await store.deleteByKey(KEY);

    expect(await store.findByKey(KEY)).toBeUndefined();
    for (const other of others) expect(await store.findByKey(other)).toEqual(at(NINE, other));
    expect(await store.saveIfAbsent(at("2026-01-05T09:05:00.000Z"))).toBe(true);
  });

  it("sweeps the answered requests whose expiry is at or before now, never one after it", async () => {
    const store = make();
    const before = { ...KEY, idempotencyKey: "before" };
    const exactly = { ...KEY, idempotencyKey: "exactly" };
    const after = { ...KEY, idempotencyKey: "after" };
    for (const [key, createdAt] of [
      [before, "2026-01-05T08:59:59.999Z"],
      [exactly, "2026-01-05T09:00:00.000Z"],
      [after, "2026-01-05T09:00:00.001Z"],
    ] as const) {
      await store.saveIfAbsent(at(createdAt, key));
      await store.saveResponse(key, "ok");
    }

    await expect(store.deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).resolves.toBe(2);

    expect(await store.findByKey(before)).toBeUndefined();
    expect(await store.findByKey(exactly)).toBeUndefined();
    expect(await store.findByKey(after)).toBeDefined();
  });

  it("never sweeps a request that has no answer yet, however old", async () => {
    const store = make();
    await store.saveIfAbsent(at(NINE));

    await expect(store.deleteExpired(new Date("2027-01-05T09:30:00.000Z"))).resolves.toBe(0);

    expect(await store.findByKey(KEY)).toBeDefined();
  });

  it("sweeps nothing from an empty store", async () => {
    await expect(make().deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).resolves.toBe(0);
  });
});

describe("#1374: the in-memory mesh request store keeps copies", () => {
  it("is not changed by the record it saved or by what it returned", async () => {
    const store = new InMemoryMeshRequestRepository(new InMemoryDatabase());
    const record = { ...at(NINE) };
    await store.saveIfAbsent(record);
    await store.saveResponse(KEY, { nested: { text: "paid" } });

    record.createdAt = "changed";
    const found = await store.findByKey(KEY);
    if (found === undefined) throw new Error("not found");
    (found.response as { nested: { text: string } }).nested.text = "changed";

    expect((await store.findByKey(KEY))?.createdAt).toBe(NINE);
    expect((await store.findByKey(KEY))?.response).toEqual({ nested: { text: "paid" } });
  });

  it("copies the answer it was given", async () => {
    const store = new InMemoryMeshRequestRepository(new InMemoryDatabase());
    const response = { nested: { text: "paid" } };
    await store.saveIfAbsent(at(NINE));
    await store.saveResponse(KEY, response);

    response.nested.text = "changed";

    expect((await store.findByKey(KEY))?.response).toEqual({ nested: { text: "paid" } });
  });

  it("names a row by the tenant, the peer and the call id, apart", () => {
    expect(meshRequestKeyOf(KEY)).toBe("acme\u0000orders-application\u0000call_1");
  });
});

describe("#1374: the SQLite mesh request store on its own", () => {
  it("is a SQLite implementation, and its table is made when the connection opens", () => {
    const connection = connectionTo(temporarySqlitePath());
    const store = new SqliteMeshRequestRepository(connection);

    expect(isSqliteImplementation(store)).toBe(true);
    expect(connection.columnsOf("mesh_requests")).toContain("idempotency_key");
  });

  it("refuses a stored answer that is no JSON, naming the store and the row's peer and key, never the text", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const store = new SqliteMeshRequestRepository(connection);
    const key = { tenantId: "default", peer: "peer-1", idempotencyKey: "key-1" };
    await store.saveIfAbsent(at(NINE, key));
    connection.database
      .prepare("UPDATE mesh_requests SET response = ?")
      .run("not json ssn-078-05-1166");

    let error: unknown;
    try {
      await store.findByKey(key);
    } catch (thrown) {
      error = thrown;
    }

    expect(String(error)).toContain("mesh request response");
    expect(String(error)).toContain("peer peer-1, idempotencyKey key-1");
    expect(String(error)).not.toContain("ssn-078-05-1166");
  });
});
