/**
 * #817 (money shard) — a child that ran on another instance hands its parent its state with its own
 * calls marked as in the ledger: one its pass wrote under an id keeps that mark (the parent counts
 * it by its id, once, across takeovers — #727), the others are recorded elsewhere (counted by what
 * they are, #685), and what it inherited from the parent is the parent's, as it was.
 */
import { describe, expect, it } from "vitest";
import { LedgerState } from "../../src/finops/ledger-mark.js";
import { recordToolCost } from "../../src/finops/usage.js";
import { recordedElsewhere } from "../../src/flow/runtime/remote/remote-child.js";
import type { ExecutionStateType } from "../../src/flow/runtime/state.js";

const MADE_AT = new Date("2026-11-04T12:00:00.000Z");
const inherited = recordToolCost("parent-tool", 1);
const written = {
  ...recordToolCost("child-tool", 2),
  ledger: { state: LedgerState.Written, ledgerId: "child:0", madeAt: MADE_AT },
};
const atStepEnd = recordToolCost("child-router", 3);

/** A child's last state holding only `usage` (the rest is never read here). */
const stateOf = (usage: ExecutionStateType["usage"]): Pick<ExecutionStateType, "usage"> => ({
  usage,
});

describe("#817: a remote child's usage as its parent takes it", () => {
  it("keeps a written mark and its id, marks the rest recorded elsewhere, leaves the inherited as it was", () => {
    const marked = recordedElsewhere(stateOf([inherited, written, atStepEnd]), 1);

    expect(marked.usage).toEqual([
      inherited,
      written,
      { ...atStepEnd, ledger: { state: LedgerState.RecordedElsewhere } },
    ]);
  });

  it("a record it inherited is never marked, whatever it carries", () => {
    const marked = recordedElsewhere(stateOf([written, inherited]), 2);

    expect(marked.usage).toEqual([written, inherited]);
  });
});
