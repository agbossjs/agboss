/** `isStoreOutcomeUnknown` (#928, #1325b): both variants of a store call of unknown outcome, from the root and the stores entry. */
import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import * as stores from "../../src/stores/index.js";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { ms } from "../../src/units/index.js";

describe("isStoreOutcomeUnknown", () => {
  const base = { store: "PgStore", operation: "save", source: stores.StoreOutcomeSource.Transport };

  it("is true for OutcomeUnknown and for CallTimeout, false for anything else", () => {
    expect(stores.isStoreOutcomeUnknown(new StoreError.OutcomeUnknown(base))).toBe(true);
    expect(
      stores.isStoreOutcomeUnknown(new StoreError.CallTimeout({ ...base, timeout: ms(5) })),
    ).toBe(true);
    expect(stores.isStoreOutcomeUnknown(new StoreError.LockTimeout())).toBe(false);
    expect(stores.isStoreOutcomeUnknown(new Error("x"))).toBe(false);
  });

  it("is exported by @agboss/core and by @agboss/core/stores, the same function", () => {
    expect(root.isStoreOutcomeUnknown).toBe(stores.isStoreOutcomeUnknown);
  });
});
