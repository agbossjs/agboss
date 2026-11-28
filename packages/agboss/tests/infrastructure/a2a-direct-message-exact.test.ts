/**
 * #1356 (shard `a2a-direct`): the direct-message stores' own decisions, on the in-memory store and on SQLite — the
 * tokens a reply keeps (and the absence of them), and what the sweep removes: only completed messages, oldest first, at
 * most a page, only of an endpoint that has a cutoff, and the cutoff's instant itself stays.
 */
import { describe, expect, it } from "vitest";
import {
  A2ADirectMessageRepository,
  A2ADirectMessageSaveStatus,
  type NewA2ADirectMessage,
} from "../../src/infrastructure/a2a-direct-message.repository.js";
import { InMemoryA2ADirectMessageRepository } from "../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { SqliteA2ADirectMessageRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-direct-message.repository.js";
import { usd } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);
const message = (id: string, endpoint = "quotes"): NewA2ADirectMessage => ({
  endpoint,
  tenantId: "default",
  ownerId: "alice",
  messageId: id,
  requestHash: `h-${id}`,
  skill: "quote-workflow-start",
  contextId: "ctx-1",
  attemptId: `run-${id}`,
  startedAt: NINE,
  expiresAt: at(30),
  callsModel: false,
  createdAt: NINE,
});
const keyOf = (id: string, endpoint = "quotes") => {
  const { tenantId, ownerId, messageId } = message(id, endpoint);
  return { tenantId, ownerId, messageId };
};

const stores: readonly (readonly [string, () => A2ADirectMessageRepository])[] = [
  ["in memory", () => new InMemoryA2ADirectMessageRepository(new InMemoryDatabase())],
  ["SQLite", () => new SqliteA2ADirectMessageRepository(connectionTo(temporarySqlitePath()))],
];

/** A message saved and completed at `completedAt`. */
async function completed(
  store: A2ADirectMessageRepository,
  id: string,
  completedAt: Date,
  endpoint = "quotes",
): Promise<void> {
  const saved = await store.saveIfAbsent(message(id, endpoint));
  expect(saved.status).toBe(A2ADirectMessageSaveStatus.Saved);
  await store.completeIfInFlight(
    keyOf(id, endpoint),
    `run-${id}`,
    { finish: "quote-finish", output: { id }, spentUsd: usd(0) },
    completedAt,
  );
}

describe.each(stores)("#1356: the direct-message store %s", (_kind, make) => {
  it("keeps the tokens a reply names, and none it does not", async () => {
    const store = make();
    await store.saveIfAbsent(message("with"));
    await store.saveIfAbsent(message("without"));

    await store.completeIfInFlight(
      keyOf("with"),
      "run-with",
      { finish: "f", output: 1, spentUsd: usd(0.5), spentTokens: 7 },
      at(1),
    );
    await store.completeIfInFlight(
      keyOf("without"),
      "run-without",
      { finish: "f", output: 1, spentUsd: usd(0.5) },
      at(1),
    );

    expect((await store.findByKey(keyOf("with")))?.reply).toStrictEqual({
      finish: "f",
      output: 1,
      spentUsd: 0.5,
      spentTokens: 7,
    });
    expect((await store.findByKey(keyOf("without")))?.reply).toStrictEqual({
      finish: "f",
      output: 1,
      spentUsd: 0.5,
    });
  });

  it("sweeps the completed messages before the cutoff, oldest first, at most a page of them", async () => {
    const store = make();
    await completed(store, "c", at(30));
    await completed(store, "a", at(10));
    await completed(store, "b", at(20));
    await completed(store, "late", at(90));

    await expect(store.deleteExpired(new Map([["quotes", at(60)]]), 2)).resolves.toBe(2);

    expect(await store.findByKey(keyOf("a"))).toBeUndefined();
    expect(await store.findByKey(keyOf("b"))).toBeUndefined();
    expect(await store.findByKey(keyOf("c"))).toBeDefined();
    expect(await store.findByKey(keyOf("late"))).toBeDefined();
  });

  it("leaves a message completed at the cutoff itself, a message in flight, and an endpoint with no cutoff", async () => {
    const store = make();
    await completed(store, "edge", at(60));
    await completed(store, "other", at(1), "orders");
    await store.saveIfAbsent(message("flying"));

    await expect(store.deleteExpired(new Map([["quotes", at(60)]]), 10)).resolves.toBe(0);

    expect(await store.findByKey(keyOf("edge"))).toBeDefined();
    expect(await store.findByKey(keyOf("other", "orders"))).toBeDefined();
    expect(await store.findByKey(keyOf("flying"))).toBeDefined();
  });
});
