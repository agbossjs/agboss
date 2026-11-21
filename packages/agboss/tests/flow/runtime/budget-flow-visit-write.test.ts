/**
 * #1366 (budget-flow shard) — what a visit writes when it leaves by an edge, and which edge it leaves by, each rule
 * on its own over fakes: nothing at a finish or when the edge writes nothing, else the values the node gave —
 * each built from what the step read, under the node's next visit number — and what they outdate; a router's route
 * the node does not have fails with the spend of its decision, a switch's case it does not have fails the output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { OutputInvalidError } from "../../../src/flow/runtime/errors.js";
import { writeAndOutdate } from "../../../src/flow/runtime/outdating.js";
import { builtFromOf } from "../../../src/flow/runtime/provenance.js";
import { RouterDecisionError } from "../../../src/flow/runtime/router-error.js";
import { recordsOfWrites } from "../../../src/flow/runtime/scope.js";
import { exitOf, visitWrite } from "../../../src/flow/runtime/visit-write.js";

vi.mock("../../../src/flow/runtime/outdating.js", () => ({ writeAndOutdate: vi.fn() }));
vi.mock("../../../src/flow/runtime/provenance.js", () => ({ builtFromOf: vi.fn() }));
vi.mock("../../../src/flow/runtime/scope.js", () => ({ recordsOfWrites: vi.fn() }));
vi.mock("../../../src/flow/runtime/step-frame.js", () => ({
  visitNumberOf: vi.fn(
    (node: { id: string }, state: { visits: Record<string, number> }) =>
      (state.visits[node.id] ?? 0) + 1,
  ),
}));
vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  recordOfNode: vi.fn((_deps: unknown, id: string) => ({ component: id })),
}));

const record = (costUsd: number): UsageRecord => ({
  ...ZERO_USAGE,
  caller: "router",
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const node = {
  id: "clerk",
  exits: {
    routes: new Map<string, object>(),
    cases: new Map<string, object>(),
    next: undefined as object | undefined,
  },
};
const scope = { kept: { slot: "kept" } };
const outcome = { read: ["v1"], value: { value: { a: 1 } } };
const provenance = { readsEverything: new Set<string>() };
const written = { made: { slot: "made" } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(builtFromOf).mockReturnValue(["v1"]);
  vi.mocked(recordsOfWrites).mockReturnValue(written as never);
  vi.mocked(writeAndOutdate).mockReturnValue({
    scope: { after: true },
    outdated: [{ slot: "old" }],
    cascades: [{ root: "r" }],
  } as never);
});

const writeBy = (exit: object | undefined, state: object, given: object = outcome) =>
  visitWrite(node as never, state as never, exit as never, given as never, provenance);

describe("#1366: the values a visit writes", () => {
  it("a finish writes nothing", () => {
    const out = writeBy(undefined, { visits: {}, scope });

    expect(out).toEqual({ update: {}, outdated: [], cascades: [] });
    expect(recordsOfWrites).not.toHaveBeenCalled();
  });

  it("an edge that writes nothing leaves the visit with nothing written, and nothing outdated", () => {
    vi.mocked(recordsOfWrites).mockReturnValue({});

    const out = writeBy({ writes: [] }, { visits: {}, scope });

    expect(out).toEqual({ update: {}, outdated: [], cascades: [] });
    expect(writeAndOutdate).not.toHaveBeenCalled();
  });

  it("writes what the node gave under its next visit number, built from what its step read, and carries what that outdated", () => {
    const writes = [{ shape: "w" }];

    const out = writeBy({ writes }, { visits: { clerk: 2 }, scope });

    expect(builtFromOf).toHaveBeenCalledWith(
      { producer: "clerk", read: ["v1"], writes },
      scope,
      provenance,
    );
    expect(recordsOfWrites).toHaveBeenCalledWith(
      { node, visitNumber: 3, builtFrom: ["v1"], scope },
      writes,
      outcome.value,
    );
    expect(writeAndOutdate).toHaveBeenCalledWith(scope, written);
    expect(out).toEqual({
      update: { scope: { after: true }, outdatedValues: [{ slot: "old" }] },
      outdated: [{ slot: "old" }],
      cascades: [{ root: "r" }],
      scope: { after: true },
    });
  });

  it("a first visit is number 1, and a node that gave no value writes an empty one", () => {
    writeBy({ writes: [{}] }, { visits: {}, scope }, { read: [] });

    const [site, , given] = vi.mocked(recordsOfWrites).mock.calls[0] ?? [];
    expect(site).toMatchObject({ visitNumber: 1 });
    expect(given).toEqual({ value: undefined });
    expect(Object.keys(given ?? {})).toEqual(["value"]);
  });

  it("the outdated list of the update is a copy of the one the write reports", () => {
    const outdated = [{ slot: "old" }];
    vi.mocked(writeAndOutdate).mockReturnValue({ scope: {}, outdated, cascades: [] } as never);

    const out = writeBy({ writes: [{}] }, { visits: {}, scope });

    expect(out.update.outdatedValues).toEqual(outdated);
    expect(out.update.outdatedValues).not.toBe(outdated);
  });
});

describe("#1366: the edge a visit leaves by", () => {
  const exits = (parts: Partial<typeof node.exits>) => ({
    ...node,
    exits: { ...node.exits, ...parts },
  });
  const leave = (exiting: object, given: object) =>
    exitOf(exiting as never, { visits: { clerk: 1 } } as never, given as never, {} as never);

  it("the route the node's router named, when it has one", () => {
    const edge = { to: "next" };
    const routes = new Map([["refund", edge]]);

    expect(leave(exits({ routes }), { route: "refund", usage: [] })).toBe(edge);
  });

  it("a route it does not have fails with the spend of the decision that named it", () => {
    const run = () => leave(exits({ routes: new Map() }), { route: "gone", usage: [record(0.25)] });

    expect(run).toThrow(RouterDecisionError);
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({
        nodeId: "clerk",
        visitNumber: 2,
        reason: '"gone" is not one of its routes',
        usage: [record(0.25)],
      });
    }
  });

  it("a switch gives the edge of the class the node gave, or the one of a class with no value", () => {
    const edge = { to: "a" };
    const none = { to: "none" };
    const cases = new Map([
      ["ADto", edge],
      ["", none],
    ]);

    expect(leave(exits({ cases }), { value: { variant: "ADto" }, usage: [] })).toBe(edge);
    expect(leave(exits({ cases }), { usage: [] })).toBe(none);
  });

  it("a class the switch has no caseOf for fails the output, naming it, or 'no class'", () => {
    const cases = new Map([["ADto", { to: "a" }]]);

    expect(() => leave(exits({ cases }), { value: { variant: "BDto" }, usage: [] })).toThrow(
      new OutputInvalidError({
        message: "clerk gave BDto, which its switch has no caseOf(…) for",
      }),
    );
    expect(() => leave(exits({ cases }), { usage: [] })).toThrow(
      "clerk gave no class, which its switch has no caseOf(…) for",
    );
  });

  it("with no route and no switch, the node's next edge (none at a finish)", () => {
    const next = { to: "next" };

    expect(leave(exits({ next }), { usage: [] })).toBe(next);
    expect(leave(exits({}), { usage: [] })).toBeUndefined();
  });
});
