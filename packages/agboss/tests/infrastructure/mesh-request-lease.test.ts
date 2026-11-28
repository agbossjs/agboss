/**
 * #1356 (shard once-mesh) — the lease and the fence of a mesh request store, on both stores: who owns a request while it
 * runs, when another attempt takes it over (only after its lease lapsed, only as the same call), and that only the
 * owner renews, answers or forgets it. Every refusal leaves the stored request as it was.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  InMemoryMeshRequestRepository,
  MeshRequestRepository,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "../../src/infrastructure/mesh-request.repository.js";
import { SqliteMeshRequestRepository } from "../../src/infrastructure/sqlite/sqlite-mesh-request.repository.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const KEY: MeshRequestKey = { tenantId: "acme", peer: "orders", idempotencyKey: "call_1" };
const T0 = "2026-01-05T09:00:00.000Z";
const LAPSED = "2026-01-05T09:00:30.000Z";
const record = (changes: Partial<MeshRequestRecord> = {}): MeshRequestRecord => ({
  ...KEY,
  tool: "status-tool",
  requestHash: "sha256:aa",
  attemptId: "attempt-1",
  createdAt: T0,
  expiresAt: "2026-01-05T09:30:00.000Z",
  lockedUntil: LAPSED,
  ...changes,
});

const stores: readonly (readonly [string, () => MeshRequestRepository])[] = [
  ["in memory", () => new InMemoryMeshRequestRepository(new InMemoryDatabase())],
  ["SQLite", () => new SqliteMeshRequestRepository(connectionTo(temporarySqlitePath()))],
];

describe.each(stores)("#1356: the lease of a request in the %s store", (_kind, make) => {
  it("keeps a request that comes with its answer finished at once, and refuses another claim", async () => {
    const store = make();

    expect(await store.saveIfAbsent(record({ response: { text: "done" } }))).toBe(true);

    expect((await store.findByKey(KEY))?.response).toEqual({ text: "done" });
    expect(await store.saveIfAbsent(record({ attemptId: "attempt-2", createdAt: LAPSED }))).toBe(
      false,
    );
    expect((await store.findByKey(KEY))?.attemptId).toBe("attempt-1");
  });

  it("is taken over once its lease is at or before the new claim, as the same call, by the new attempt", async () => {
    const store = make();
    await store.saveIfAbsent(record());
    const again = record({
      attemptId: "attempt-2",
      createdAt: LAPSED,
      lockedUntil: "2026-01-05T09:01:00.000Z",
      expiresAt: "2026-01-05T09:31:00.000Z",
    });

    expect(
      await store.saveIfAbsent(
        record({ attemptId: "early", createdAt: "2026-01-05T09:00:29.999Z" }),
      ),
    ).toBe(false);
    expect(await store.saveIfAbsent(again)).toBe(true);

    // the attempt, the time it came and its lease are the new ones; the request's window is the first's
    expect(await store.findByKey(KEY)).toEqual({ ...again, expiresAt: "2026-01-05T09:30:00.000Z" });
  });

  it("is never taken over by another tool, another request, or once it has its answer", async () => {
    const store = make();
    await store.saveIfAbsent(record());
    const later = { attemptId: "attempt-2", createdAt: "2026-01-05T09:05:00.000Z" };

    expect(await store.saveIfAbsent(record({ ...later, tool: "other-tool" }))).toBe(false);
    expect(await store.saveIfAbsent(record({ ...later, requestHash: "sha256:bb" }))).toBe(false);
    await store.saveResponse(KEY, "attempt-1", "answer");
    expect(await store.saveIfAbsent(record(later))).toBe(false);

    expect(await store.findByKey(KEY)).toEqual(record({ response: "answer" }));
  });

  it("is renewed by its attempt alone: the lease moves, and only for it", async () => {
    const store = make();
    await store.saveIfAbsent(record());

    expect(await store.renewLease(KEY, "attempt-2", "2026-01-05T09:10:00.000Z")).toBe(false);
    expect((await store.findByKey(KEY))?.lockedUntil).toBe(LAPSED);
    expect(await store.renewLease({ ...KEY, idempotencyKey: "call_2" }, "attempt-1", "x")).toBe(
      false,
    );
    expect(await store.renewLease(KEY, "attempt-1", "2026-01-05T09:10:00.000Z")).toBe(true);
    expect((await store.findByKey(KEY))?.lockedUntil).toBe("2026-01-05T09:10:00.000Z");
  });

  it("is not renewed once it has its answer", async () => {
    const store = make();
    await store.saveIfAbsent(record());
    await store.saveResponse(KEY, "attempt-1", "answer");

    expect(await store.renewLease(KEY, "attempt-1", "2026-01-05T09:10:00.000Z")).toBe(false);

    expect((await store.findByKey(KEY))?.lockedUntil).toBe(LAPSED);
  });

  it("is answered by its attempt alone, and once", async () => {
    const store = make();
    await store.saveIfAbsent(record());

    expect(await store.saveResponse(KEY, "attempt-2", "stranger")).toBe(false);
    expect(await store.findByKey(KEY)).not.toHaveProperty("response");
    expect(await store.saveResponse({ ...KEY, peer: "other" }, "attempt-1", "stranger")).toBe(
      false,
    );
    expect(await store.saveResponse(KEY, "attempt-1", "first")).toBe(true);
    expect(await store.saveResponse(KEY, "attempt-1", "second")).toBe(false);

    expect((await store.findByKey(KEY))?.response).toBe("first");
  });

  it("is forgotten by its attempt alone", async () => {
    const store = make();
    await store.saveIfAbsent(record());

    expect(await store.deleteByKey(KEY, "attempt-2")).toBe(false);
    expect(await store.findByKey(KEY)).toEqual(record());
    expect(await store.deleteByKey({ ...KEY, tenantId: "other" }, "attempt-1")).toBe(false);
    expect(await store.deleteByKey(KEY, "attempt-1")).toBe(true);
    expect(await store.findByKey(KEY)).toBeUndefined();
    expect(await store.deleteByKey(KEY, "attempt-1")).toBe(false);
  });

  it("is swept once answered and expired, though its lease has not lapsed", async () => {
    const store = make();
    await store.saveIfAbsent(record({ lockedUntil: "2026-01-05T10:00:00.000Z" }));
    await store.saveResponse(KEY, "attempt-1", "answer");

    await expect(store.deleteExpired(new Date("2026-01-05T09:29:59.999Z"))).resolves.toBe(0);
    await expect(store.deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).resolves.toBe(1);

    expect(await store.findByKey(KEY)).toBeUndefined();
  });

  it("is not swept while running with a lease that has not lapsed, however old its window", async () => {
    const store = make();
    await store.saveIfAbsent(record({ lockedUntil: "2026-01-05T10:00:00.000Z" }));

    await expect(store.deleteExpired(new Date("2026-01-05T09:45:00.000Z"))).resolves.toBe(0);

    expect(await store.findByKey(KEY)).toBeDefined();
  });
});
