/**
 * #860 (mutation shard `a2a-direct`): the direct-message stores' parts on their own — the contract's
 * undeclared backend, a page's limit refused with its value, the SQLite row's refusals (a state and
 * a reply that disagree, a corrupt reply), the SQLite store alone on a connection; and the sweep's
 * paging: exactly a page read means another page, a shorter one ends it, 20 pages at most a look.
 */
import { describe, expect, it, vi } from "vitest";
import {
  A2ADirectMessageRepository,
  A2ADirectMessageSaveStatus,
  type A2ADirectMessageRecord,
} from "../../src/infrastructure/a2a-direct-message.repository.js";
import { a2aDirectMessageExpiryOf } from "../../src/infrastructure/a2a-direct-message-expiry.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import {
  checkedDirectMessageLimit,
  InMemoryA2ADirectMessageRepository,
} from "../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { directMessageOf } from "../../src/infrastructure/sqlite/sqlite-a2a-direct-message-rows.js";
import { SqliteA2ADirectMessageRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-direct-message.repository.js";
import { isSqliteImplementation } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");

describe("#860: the direct-message store's parts", () => {
  it("the contract declares no backend of its own", () => {
    expect(A2ADirectMessageRepository.store).toStrictEqual({ backend: undefined });
  });

  it("a page's limit that is no whole number from 1 is a RangeError naming it", () => {
    expect(() => checkedDirectMessageLimit(1.5)).toThrow(
      "a page of direct A2A messages holds a whole number from 1, not 1.5",
    );
  });

  it("the SQLite store, alone on its file, keeps a message: its id's claim table is its own to make", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const store = new SqliteA2ADirectMessageRepository(connection);

    const save = await store.saveIfAbsent({
      tenantId: "default",
      ownerId: "alice",
      messageId: "m-1",
      requestHash: "h-1",
      skill: "quote-workflow-start",
      contextId: "ctx-1",
      attemptId: "run-1",
      startedAt: NINE,
      expiresAt: NINE,
      callsModel: false,
      createdAt: NINE,
    });

    expect(save.status).toBe(A2ADirectMessageSaveStatus.Saved);
    expect(isSqliteImplementation(store)).toBe(true);
  });
});

/** A row as the SQLite store writes it: in flight, no reply. */
const row = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: "default",
  owner_id: "alice",
  message_id: "m-1",
  request_hash: "h-1",
  skill: "quote-workflow-start",
  context_id: "ctx-1",
  state: "in-flight",
  attempt_id: "run-1",
  calls_model: 1,
  created_at: NINE.toISOString(),
  started_at: NINE.toISOString(),
  expires_at: NINE.toISOString(),
  caller_peer: null,
  mesh_body_hash: null,
  reply: null,
  completed_at: null,
  ...overrides,
});

const REPLY = JSON.stringify({ finish: "f", output: { a: 1 }, spentUsd: 0 });
const DISAGREE = "a2a_direct_messages row m-1: its state and its reply disagree";

describe("#860: a SQLite row of a direct message", () => {
  it("in flight without a reply, completed with one and its date: read", () => {
    const completed = row({ state: "completed", reply: REPLY, completed_at: NINE.toISOString() });

    expect(directMessageOf(row())).not.toHaveProperty("reply");
    expect(directMessageOf(completed)).toMatchObject({
      reply: { finish: "f", output: { a: 1 }, spentUsd: 0 },
      completedAt: NINE,
    });
  });

  it("whose state and reply disagree, even by one column, is refused", () => {
    const rows = [
      row({ reply: REPLY }),
      row({ completed_at: NINE.toISOString() }),
      row({ state: "completed", reply: REPLY }),
      row({ state: "completed", completed_at: NINE.toISOString() }),
    ];

    const refusalOf = (each: unknown): unknown => {
      try {
        return directMessageOf(each);
      } catch (error) {
        return error instanceof Error ? error.message : error;
      }
    };

    expect(rows.map(refusalOf)).toEqual([DISAGREE, DISAGREE, DISAGREE, DISAGREE]);
  });

  it("whose reply is not the JSON of a reply is refused", () => {
    const completed = { state: "completed", completed_at: NINE.toISOString() };

    expect(() => directMessageOf(row({ ...completed, reply: "{" }))).toThrow(SyntaxError);
    expect(() => directMessageOf(row({ ...completed, reply: '{"finish":1}' }))).toThrow();
  });
});

/** The sweep over a store whose pages hold `sizes[i]` rows each (then none): the pages it asked. */
async function pagesRead(sizes: readonly number[], kind: "lost" | "old"): Promise<number> {
  let asked = 0;
  const page = (): readonly A2ADirectMessageRecord[] => {
    const size = sizes[asked] ?? 0;
    asked += 1;
    return Array.from({ length: size }, (_, n) => ({
      ...directMessageOf(row({ message_id: `m-${String(n)}` })),
    }));
  };
  const messages = new InMemoryA2ADirectMessageRepository(new InMemoryDatabase());
  vi.spyOn(messages, "findAllInFlightByExpiresAtBefore").mockImplementation(() =>
    Promise.resolve(kind === "lost" ? page() : []),
  );
  vi.spyOn(messages, "deleteIfInFlight").mockResolvedValue(false);
  vi.spyOn(messages, "deleteByCreatedAtBefore").mockImplementation(() =>
    Promise.resolve(kind === "old" ? page() : []),
  );
  const files = new InMemoryA2AFileRepository(new InMemoryDatabase());
  vi.spyOn(files, "deleteByOwner").mockResolvedValue(undefined);
  const expiry = a2aDirectMessageExpiryOf({
    messages,
    files,
    ledger: new InMemoryCostLedgerRepository(),
    clock: new VirtualClock(NINE),
    retention: minutes(15),
  });
  await expiry.remove?.(NINE);
  return asked;
}

describe("#860: the sweep's pages", () => {
  it("is the sweep of the direct A2A messages", () => {
    const expiry = a2aDirectMessageExpiryOf({
      messages: {} as A2ADirectMessageRepository,
      files: new InMemoryA2AFileRepository(new InMemoryDatabase()),
      ledger: new InMemoryCostLedgerRepository(),
      clock: new VirtualClock(NINE),
      retention: minutes(15),
    });

    expect([expiry.what, expiry.retention]).toEqual(["the direct A2A messages", minutes(15)]);
  });

  for (const kind of ["lost", "old"] as const)
    it(`of ${kind} messages: a full page of 100 reads another, a shorter one ends it, 20 pages at most`, async () => {
      expect(await pagesRead([100, 0], kind)).toBe(2);
      expect(await pagesRead([99], kind)).toBe(1);
      expect(
        await pagesRead(
          Array.from({ length: 30 }, () => 100),
          kind,
        ),
      ).toBe(20);
    });
});
