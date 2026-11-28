/** #1341b, #1356 (WP6, unwind shard): the unwind of a stopped tree runs nothing. */
import { describe, expect, it, vi } from "vitest";
import { unwound, type UnwindSite } from "../../../src/flow/runtime/compensation/unwind.js";
import { entryOf } from "./fixtures/compensation-entries.js";

describe("unwound", () => {
  it("a stopped tree: nothing undone, nothing waited for, nothing sealed", async () => {
    const undoSiteOf = vi.fn(() => {
      throw new Error("must not be asked");
    });
    const onUndone = vi.fn();
    const site: UnwindSite = {
      tree: { tenantId: "acme", rootExecutionId: "root-1" },
      covers: () => true,
      runs: () => true,
      known: [entryOf("open")],
      undoSiteOf,
      onUndone,
      isSealing: true,
      isStopped: true,
    } as never;

    const result = await unwound(site);

    expect(result).toStrictEqual({ closed: [], usage: [], failures: [] });
    expect(undoSiteOf).not.toHaveBeenCalled();
    expect(onUndone).not.toHaveBeenCalled();
  });
});
