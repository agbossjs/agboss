/**
 * #825 — the paged listing's parts on their own: a page and its cursor, the limit's and the cursor's
 * refusals with their texts, an in-memory row's place, and a pruned row's place gone with it.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  nextPlaceIn,
  outboundCallPageOf,
  pageLimitOf,
  placeIn,
  placeOfCursor,
} from "../../src/infrastructure/outbound-call-pages.js";
import {
  InMemoryOutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallRecord,
} from "../../src/infrastructure/outbound-call.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { intentOf } from "../../src/testing/contracts/outbound-call-data.js";
import { hours } from "../../src/units/index.js";

const record = (name: string): OutboundCallRecord => ({ name }) as OutboundCallRecord;
const rowsOf = (...places: number[]) =>
  places.map((place) => ({ place, record: record(`call-${String(place)}`) }));

describe("#825: a page of the rows read one past its limit", () => {
  it("no row past the limit: the calls, no next", () => {
    expect(outboundCallPageOf(rowsOf(3, 7), 2)).toStrictEqual({
      calls: [record("call-3"), record("call-7")],
    });
    expect(outboundCallPageOf([], 1)).toStrictEqual({ calls: [] });
  });

  it("a row past it: the first limit's calls, next the last one's place", () => {
    expect(outboundCallPageOf(rowsOf(3, 7, 12), 2)).toStrictEqual({
      calls: [record("call-3"), record("call-7")],
      next: "7",
    });
  });
});

describe("#825: the limit and the cursor, checked", () => {
  it("a whole number from 1 is taken; anything else is a RangeError naming it", () => {
    expect(pageLimitOf(1)).toBe(1);
    expect(pageLimitOf(1000)).toBe(1000);
    for (const limit of [0, -1, 1.5, Number.NaN])
      expect(() => pageLimitOf(limit)).toThrow(
        new RangeError(`a page's limit is a whole number of calls from 1, got ${String(limit)}`),
      );
  });

  it("a cursor is the place it names, any number of digits; else a RangeError", () => {
    expect(placeOfCursor("1")).toBe(1);
    expect(placeOfCursor("12")).toBe(12);
    expect(placeOfCursor("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    for (const cursor of ["0", "01", "1e3", "abc", "1a", "-1", "9007199254740992", ""])
      expect(() => placeOfCursor(cursor)).toThrow(
        new RangeError("the cursor is not one this store gave: pass the next of one of its pages"),
      );
  });
});

describe("#825: an in-memory row's place in the record order", () => {
  it("given once per database, counted up, never again", () => {
    const one = new InMemoryDatabase();
    const other = new InMemoryDatabase();

    expect([nextPlaceIn(one), nextPlaceIn(one), nextPlaceIn(other)]).toEqual([1, 2, 1]);
  });

  it("a row without one is refused, naming what wrote it", () => {
    expect(placeIn(new Map([["a", 4]]), "a")).toBe(4);
    expect(() => placeIn(new Map(), "a")).toThrow(
      "an in-memory outbound call without its place in the record order: written past saveIfAbsent",
    );
  });

  it("a pruned row's place goes with it", async () => {
    const clock = new VirtualClock();
    const database = new InMemoryDatabase();
    const application = applicationContextOf({
      ...{ name: "pages-application", version: "1.0.0", instanceId: "instance-1" },
      ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
    });
    const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
    const calls = new InMemoryOutboundCallRepository(clock, database, leases);
    const lease = await leases.acquire("default", "execution-1", hours(1));
    if (lease === undefined) throw new Error("the lease is held");
    const key = effectKeyForTesting(keyOf(lease, "charge"));
    await calls.saveIfAbsent(key, intentOf(key));
    // the intent ended long ago: what the sweep removes
    for (const [row, found] of database.outboundCalls)
      database.outboundCalls.set(row, {
        ...found,
        status: OutboundCallStatus.Completed,
        endedAt: new Date(0).toISOString(),
      });
    expect(database.outboundCallOrder.size).toBe(1);

    await calls.deleteByEndedAtBefore(new Date(1));

    expect(database.outboundCalls.size).toBe(0);
    expect(database.outboundCallOrder.size).toBe(0);
  });
});
