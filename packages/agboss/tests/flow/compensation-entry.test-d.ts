import { describe, expectTypeOf, it } from "vitest";
import type { CompensationEntry } from "../../src/index.js";
import type { CompensationEntry as StoredEntry } from "../../src/stores/index.js";

/** #1281b: an entry a child's finish moved up names its holder and the path down to its workflow. */
describe("#1281b: CompensationEntry.heldBy / childPath", () => {
  it("both optional, read-only: an execution id and the holder's nodes of the children", () => {
    expectTypeOf<CompensationEntry["heldBy"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CompensationEntry["childPath"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<StoredEntry>().toEqualTypeOf<CompensationEntry>();
  });
});
