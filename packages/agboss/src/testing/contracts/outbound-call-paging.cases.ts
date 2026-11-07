import { expect } from "vitest";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import type { OutboundCallRecord } from "../../infrastructure/outbound-call.repository.js";
import { hours } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import {
  listedOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallStores,
} from "./outbound-call-data.js";

/**
 * The paged listing of a tenant's calls by status (#825): `findAllByTenantIdAndStatus({ tenantId,
 * status, limit, after })` → `{ calls, next? }`. Pages cover the calls exactly once in the store's
 * record order; a call in the status for the whole read is listed exactly once whatever is recorded,
 * ends or is removed between pages — a cursor is a place in an immutable order, never an offset —
 * and no call is listed twice; `next` is absent on the last page only.
 */

const PENDING = OutboundCallStatus.Pending;

/** The names of `calls`. */
const namesOf = (calls: readonly OutboundCallRecord[]): readonly string[] =>
  calls.map((call) => call.name);

/** One page of the tenant's pending calls. */
const pageOf = (stores: OutboundCallStores, limit: number, after?: string) =>
  stores.calls.findAllByTenantIdAndStatus({ tenantId: "default", status: PENDING, limit, after });

const pagesCoverOnce: OutboundCallCase = {
  name: "#825: pages of limit 2 list five pending calls once each, in the order recorded — next on every page but the last",
  run: async ({ first, second }) => {
    const lease = await leaseOf(first, "execution-1", hours(1));
    for (const name of ["a", "b", "c", "d", "e"]) await recorded(first, keyOf(lease, name));

    const one = await pageOf(second, 2);
    const two = await pageOf(second, 2, one.next);
    const three = await pageOf(second, 2, two.next);

    expect([namesOf(one.calls), namesOf(two.calls), namesOf(three.calls)]).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(one.next).toBeTypeOf("string");
    expect(two.next).toBeTypeOf("string");
    expect(three.next).toBeUndefined();
    expect(namesOf(await listedOf(second, PENDING, "default", 1))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  },
};

const exactPageEnds: OutboundCallCase = {
  name: "#825: a page that takes the last calls exactly ends the listing — no next, never an empty page after it",
  run: async ({ first }) => {
    const lease = await leaseOf(first, "execution-1", hours(1));
    for (const name of ["a", "b"]) await recorded(first, keyOf(lease, name));

    const only = await pageOf(first, 2);

    expect(namesOf(only.calls)).toEqual(["a", "b"]);
    expect(only.next).toBeUndefined();
    expect((await pageOf(first, 5)).next).toBeUndefined();
  },
};

const changesBetweenPages: OutboundCallCase = {
  name: "#825: calls recorded and calls ended between two pages move no other call — the calls pending throughout are listed exactly once, none twice",
  run: async ({ first, second }) => {
    const lease = await leaseOf(first, "execution-1", hours(1));
    for (const name of ["a", "b", "c", "d", "e"]) await recorded(first, keyOf(lease, name));
    const one = await pageOf(second, 2);
    // between the pages: a listed one and an unlisted one end, a new one is recorded
    await first.calls.markCompleted(keyOf(lease, "a"), "owner-1", "{}");
    await first.calls.markCompleted(keyOf(lease, "c"), "owner-1", "{}");
    await recorded(first, keyOf(lease, "f"));

    const rest = await listedOf(second, PENDING, "default", 2, one.next);
    const listed = [...namesOf(one.calls), ...namesOf(rest)];

    expect(namesOf(one.calls)).toEqual(["a", "b"]);
    // b, d and e were pending for the whole read: each exactly once
    for (const name of ["b", "d", "e"])
      expect(listed.filter((seen) => seen === name)).toEqual([name]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).not.toContain("c");
  },
};

const cursorRowRemoved: OutboundCallCase = {
  name: "#825: the call a cursor names ended and removed by the retention before the next page — the next page still starts after it",
  run: async ({ clock, first, second }) => {
    const lease = await leaseOf(first, "execution-1", hours(100));
    for (const name of ["a", "b", "c", "d"]) await recorded(first, keyOf(lease, name));
    const one = await pageOf(second, 2);
    await first.calls.markCompleted(keyOf(lease, "b"), "owner-1", "{}");
    await clock.advance(hours(2));
    await first.calls.deleteByEndedAtBefore(new Date(clock.now().getTime() - hours(1)));

    const two = await pageOf(second, 2, one.next);

    expect(namesOf(two.calls)).toEqual(["c", "d"]);
    expect(two.next).toBeUndefined();
  },
};

const tenantsApart: OutboundCallCase = {
  name: "#825: another tenant's calls are never on a tenant's pages — and do not end its pages early",
  run: async ({ first, second }) => {
    const own = await leaseOf(first, "execution-1", hours(1));
    const other = await leaseOf(first, "execution-2", hours(1), "acme");
    await recorded(first, keyOf(own, "a"));
    for (const name of ["x", "y", "z"]) await recorded(first, keyOf(other, name));
    await recorded(first, keyOf(own, "b"));

    expect(namesOf(await listedOf(second, PENDING, "default", 1))).toEqual(["a", "b"]);
    expect(namesOf(await listedOf(second, PENDING, "acme", 2))).toEqual(["x", "y", "z"]);
  },
};

const limitChecked: OutboundCallCase = {
  name: "#825: a limit that is no whole number from 1 — 0, a fraction, NaN, a negative one — is refused, never an empty last page or no limit",
  run: async ({ first }) => {
    const lease = await leaseOf(first, "execution-1", hours(1));
    await recorded(first, keyOf(lease, "a"));

    for (const limit of [0, 1.5, Number.NaN, -1])
      await expect(pageOf(first, limit)).rejects.toBeInstanceOf(RangeError);
    expect(namesOf((await pageOf(first, 1)).calls)).toEqual(["a"]);
  },
};

/** The paged listing by status (#825). */
export const outboundPagingCases = (): ContractGroup<OutboundCallStores> => ({
  title: "paged listing by status",
  cases: [
    pagesCoverOnce,
    exactPageEnds,
    changesBetweenPages,
    cursorRowRemoved,
    tenantsApart,
    limitChecked,
  ],
});
