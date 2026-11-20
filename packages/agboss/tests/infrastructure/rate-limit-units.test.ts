/**
 * #1356 — the built-in rate limit stores on their own, in memory and on SQLite: a slot renewed is that slot
 * only, the window drops what left it and keeps nothing of nothing, a limit of none is no limit, a pause
 * keeps the first of two equal ends, and what a store returns says when it ends.
 */
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  InMemoryRateLimitRepository,
  type RateLimitRepository,
} from "../../src/infrastructure/rate-limit.repository.js";
import { isSqliteImplementation } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteRateLimitRepository } from "../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const application = applicationContextOf({
  name: "rate-limit-units",
  version: "1.0.0",
  instanceId: "instance-1",
  startedAt: new Date(0),
  environmentName: "test",
  environment: NO_ENVIRONMENT_VALUES,
});

interface Made {
  readonly store: RateLimitRepository;
  readonly clock: VirtualClock;
  /** How many entries the key's window holds, as the store keeps them. */
  readonly entries: (key: string) => number;
}

const kinds: readonly (readonly [string, () => Made])[] = [
  [
    "in memory",
    () => {
      const clock = new VirtualClock(new Date(0));
      const database = new InMemoryDatabase();
      return {
        store: new InMemoryRateLimitRepository(clock, application, database),
        clock,
        entries: (key) => database.rateLimitWindows.get(key)?.length ?? 0,
      };
    },
  ],
  [
    "SQLite",
    () => {
      const clock = new VirtualClock(new Date(0));
      const connection = connectionTo(temporarySqlitePath());
      return {
        store: new SqliteRateLimitRepository(connection, clock, application),
        clock,
        entries: (key) =>
          Number(
            Object.values(
              connection.database
                .prepare("SELECT COUNT(*) FROM rate_limit_window_entries WHERE window_key = ?")
                .get(key) ?? {},
            )[0],
          ),
      };
    },
  ],
];

describe.each(kinds)("#1356: the rate limit store %s", (_kind, make) => {
  it("answers a ping", async () => {
    const { store } = make();

    await expect(store.ping()).resolves.toBeUndefined();
  });

  it("a slot taken says which key, which instance and until when", async () => {
    const { store } = make();

    const slot = await store.acquire("openrouter", 1, seconds(30));

    expect(slot).toMatchObject({
      key: "openrouter",
      holderInstanceId: "instance-1",
      expiresAt: new Date(30_000),
    });
  });

  it("renewing a slot extends that slot only", async () => {
    const { store, clock } = make();
    const first = await store.acquire("openrouter", 2, seconds(30));
    await store.acquire("openrouter", 2, seconds(30));
    if (first === undefined) throw new Error("the first slot was refused");

    expect(await store.renew(first, seconds(60))).toBe(true);
    await clock.advance(seconds(31));

    // the other slot ran out, the renewed one holds: one of two is free
    expect(await store.acquire("openrouter", 2, seconds(30))).toBeDefined();
    expect(await store.acquire("openrouter", 2, seconds(30))).toBeUndefined();
  });

  it("a window with no limit takes everything and counts it; a limit of its own refuses what passes it", async () => {
    const { store } = make();

    expect(await store.addToWindow("tokens", 40, seconds(60))).toBe(40);
    expect(await store.addToWindow("tokens", 40, seconds(60))).toBe(80);
    expect(await store.addToWindow("tokens", 20, seconds(60), 100)).toBe(100);
    expect(await store.addToWindow("tokens", 1, seconds(60), 100)).toBeUndefined();
    expect(await store.addToWindow("tokens", 0, seconds(60), 100)).toBe(100);
  });

  it("an amount of nothing is counted, and kept as nothing", async () => {
    const { store, entries } = make();

    expect(await store.addToWindow("tokens", 0, seconds(60))).toBe(0);
    expect(entries("tokens")).toBe(0);
    expect(await store.addToWindow("tokens", 3, seconds(60))).toBe(3);
    expect(entries("tokens")).toBe(1);
  });

  it("what left the window is forgotten, also when the amount is refused", async () => {
    const { store, clock, entries } = make();
    await store.addToWindow("tokens", 10, seconds(60));
    await clock.advance(seconds(61));

    expect(await store.addToWindow("tokens", 5, seconds(60), 3)).toBeUndefined();

    expect(entries("tokens")).toBe(0);
    expect(await store.addToWindow("tokens", 3, seconds(60), 3)).toBe(3);
  });

  it("a pause ends when it ends; once it ended the key is not paused", async () => {
    const { store, clock } = make();

    expect(await store.pausedUntil("p")).toBeUndefined();
    await store.pauseUntil("p", new Date(5_000));
    expect(await store.pausedUntil("p")).toEqual(new Date(5_000));
    await clock.advance(seconds(5));
    expect(await store.pausedUntil("p")).toBeUndefined();
  });

  it("a second pause ends the pause later only: the later end wins, the same end changes nothing", async () => {
    const { store } = make();

    await store.pauseUntil("p", new Date(5_000));
    await store.pauseUntil("p", new Date(3_000));
    expect(await store.pausedUntil("p")).toEqual(new Date(5_000));
    await store.pauseUntil("p", new Date(9_000));
    expect(await store.pausedUntil("p")).toEqual(new Date(9_000));
  });
});

describe("#1356: a pause of an equal end on the in-memory store", () => {
  it("keeps the end it has: the same one is not stored again", async () => {
    const clock = new VirtualClock(new Date(0));
    const store = new InMemoryRateLimitRepository(clock, application, new InMemoryDatabase());
    const first = new Date(5_000);

    await store.pauseUntil("p", first);
    await store.pauseUntil("p", new Date(5_000));

    expect(await store.pausedUntil("p")).toBe(first);
  });
});

describe("#1356: the SQLite rate limit store", () => {
  it("is an implementation that needs the SQLite file", () => {
    const store = new SqliteRateLimitRepository(
      connectionTo(temporarySqlitePath()),
      new VirtualClock(new Date(0)),
      application,
    );

    expect(isSqliteImplementation(store)).toBe(true);
  });
});
