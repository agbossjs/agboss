/** #1288b: a slice and the polymorphic list it is cut from are twins: a newer value of one outdates the other. */
import { describe, expect, it } from "vitest";
import type { SlotKey } from "../../../src/flow/analyse/scope.js";
import { twinSlotsOf } from "../../../src/flow/analyse/slices.js";
import { writeAndOutdate } from "../../../src/flow/runtime/outdating.js";
import type { ScopeRecords, ScopeValueRecord } from "../../../src/flow/runtime/records.js";

const slot = (text: string): SlotKey => text as SlotKey;
const record = (producer: string, name: string): ScopeValueRecord => ({
  valueId: `${producer}:1/${name}`,
  slot: name,
  producer,
  value: [],
  builtFrom: [],
});
const scopeOf = (...records: ScopeValueRecord[]): ScopeRecords =>
  Object.fromEntries(records.map((one) => [one.slot, one]));

describe("#1288b: twin slots", () => {
  it("names the slices of a list and the lists of a slice", () => {
    const all = [
      slot("list:oneOf(ADto,BDto)"),
      slot("list:ADto"),
      slot("list:BDto"),
      slot("list:CDto"),
    ];

    expect(twinSlotsOf(slot("list:oneOf(ADto,BDto)"), all)).toEqual([
      slot("list:ADto"),
      slot("list:BDto"),
    ]);
    expect(twinSlotsOf(slot("list:ADto"), all)).toEqual([slot("list:oneOf(ADto,BDto)")]);
    expect(twinSlotsOf(slot("list:CDto"), all)).toEqual([]);
    expect(twinSlotsOf(slot("ADto"), all)).toEqual([]);
  });

  it("a new slice outdates the list that holds its class; the other slices stay", () => {
    const scope = scopeOf(
      record("check", "list:oneOf(ADto,BDto)"),
      record("check", "list:ADto"),
      record("check", "list:BDto"),
    );

    const outcome = writeAndOutdate(scope, scopeOf(record("redo", "list:ADto")));

    expect(Object.keys(outcome.scope).sort()).toEqual(["list:ADto", "list:BDto"]);
    expect(outcome.outdated.map((old) => old.slot).sort()).toEqual([
      "list:ADto",
      "list:oneOf(ADto,BDto)",
    ]);
  });

  it("a list and its slices written together outdate nothing of each other", () => {
    const scope = scopeOf(record("check", "list:oneOf(ADto,BDto)"), record("check", "list:ADto"));

    const outcome = writeAndOutdate(
      scope,
      scopeOf(record("again", "list:oneOf(ADto,BDto)"), record("again", "list:ADto")),
    );

    expect(Object.values(outcome.scope).map((one) => one.producer)).toEqual(["again", "again"]);
  });
});
