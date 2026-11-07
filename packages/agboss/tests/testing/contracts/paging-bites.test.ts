/**
 * #825 acceptance: the paged listing's cases bite. A store that pages by an offset into what matches
 * now skips a call pending for the whole read once a listed one ends between pages; one that names
 * its cursor by the last row starts over once that row is removed, listing calls twice. Each fails
 * the case of its fault, and the cases a correct pager passes stay green where the fault is absent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const FIXTURE = "paging-by-offset.contract-fixture.ts";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([FIXTURE]);
}, 120_000);

/** The #825 paging cases of `target`'s suite: the state of the one whose name starts with each. */
const statesOf = (target: string) => {
  const cases = run.cases
    .filter((found) => found.suites[0]?.endsWith(`(${target})`) === true)
    .filter((found) => found.name.startsWith("#825:"));
  return { get: (start: string) => cases.find((found) => found.name.startsWith(start))?.state };
};

const BETWEEN_PAGES = "#825: calls recorded and calls ended between two";
const CURSOR_REMOVED = "#825: the call a cursor names ended and removed b";
const COVER_ONCE = "#825: pages of limit 2 list five pending calls o";

describe("#825: a store that pages naively fails the paging cases", () => {
  it("by an offset: a listed call that ends between pages makes the next page skip one pending throughout", () => {
    const states = statesOf("calls paged by an offset");
    expect(states.get(BETWEEN_PAGES)).toBe("fail");
    expect(states.get(COVER_ONCE)).toBe("pass");
  });

  it("after the last row's name: a cursor whose row was removed starts over — calls listed twice", () => {
    const states = statesOf("calls paged after the last row's name");
    expect(states.get(CURSOR_REMOVED)).toBe("fail");
    expect(states.get(COVER_ONCE)).toBe("pass");
  });
});
