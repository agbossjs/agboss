/** #1321b: the window of a `PageQuery` a store that pages by position reads. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  listingWindowOf,
  pageOfWindow,
} from "../../src/infrastructure/listing-window.js";

describe("#1321b: listingWindowOf / pageOfWindow", () => {
  it("no cursor and no limit: the first page of the default size", () => {
    expect(listingWindowOf({})).toEqual({ offset: 0, limit: DEFAULT_PAGE_LIMIT });
  });

  it("a cursor a page gave continues after it", () => {
    const window = listingWindowOf({ limit: 2 });
    const page = pageOfWindow(["a", "b", "c"], window);

    expect(page).toEqual({ items: ["a", "b"], nextCursor: "2" });
    expect(listingWindowOf({ limit: 2, cursor: page.nextCursor })).toEqual({ offset: 2, limit: 2 });
  });

  it("the last page has no cursor", () => {
    expect(pageOfWindow(["a", "b"], { offset: 0, limit: 2 })).toEqual({ items: ["a", "b"] });
  });

  it.each(["", "-1", "1.5", "abc", "1e3", "9999999999999999"])(
    "a cursor no listing gave (%j) is refused",
    (cursor) => {
      expect(() => listingWindowOf({ cursor })).toThrow("the cursor is not one a listing gave");
    },
  );

  it.each([0, -1, 1.5, Number.NaN])("a limit of %s is refused", (limit) => {
    expect(() => listingWindowOf({ limit })).toThrow("a page's limit is a positive whole number");
  });
});
