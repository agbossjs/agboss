/**
 * #1280, #1356 (WP6, unwind shard): a list longer than `maxItems` is `LimitError.Items`, taken by the
 * join's `.onError` handler — which launches overflow, what the failure says, and where it goes.
 */
import { describe, expect, it, vi } from "vitest";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { errorRecordOf } from "../../../src/core/error-record.js";
import { EdgeKind } from "../../../src/flow/analyse/flow-graph.js";
import {
  isItemsOverflow,
  itemsOverflowOf,
  joinErrorTaken,
} from "../../../src/flow/runtime/launch/items-limit.js";
import { StepError } from "../../../src/core/error-families/step-errors.js";

vi.mock("../../../src/flow/runtime/limits.js", () => ({
  sidePathEntered: vi.fn((_state: unknown, record: unknown, to: unknown) => ({
    sidePath: { entered: to, record },
  })),
}));
vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  handledErrorOf: vi.fn((_records: unknown, error: unknown, at: unknown, by: unknown) => ({
    handled: { error, at, by },
  })),
}));

const launchOf = (
  over: { form?: string; maxItems?: number | undefined } = {},
  handlers: readonly unknown[] = [],
) =>
  ({
    launch: { form: "for-each-item", maxItems: 3, ...over },
    joinErrors: handlers,
  }) as never;
const ticketOf = (items: number) => ({ items }) as never;
const handlerFor = (error: unknown, to: string) =>
  ({ from: "join", to, kind: EdgeKind.JoinError, writes: [], error }) as never;

describe("which launches overflow", () => {
  it.each([
    ["a per-item launch past its bound", launchOf(), 4, true],
    ["a per-item launch at its bound", launchOf(), 3, false],
    ["a per-item launch under its bound", launchOf(), 1, false],
    ["a per-item launch with no bound", launchOf({ maxItems: undefined }), 1000, false],
    ["a launch that is not per item, past a bound", launchOf({ form: "in-parallel" }), 4, false],
  ])("%s: %s", (_label, launch, items, expected) => {
    expect(isItemsOverflow(launch, ticketOf(items))).toBe(expected);
  });
});

describe("the way out of an overflow", () => {
  const node = { id: "finder-agent" } as never;
  const state = { path: ["start", "intake"], compensations: [] } as never;
  const records = {} as never;

  it("is none when the list did not pass its bound", () => {
    expect(itemsOverflowOf({ launch: launchOf(), ticket: ticketOf(3) }, node, state, records)).toBe(
      undefined,
    );
    expect(
      itemsOverflowOf(
        { launch: launchOf({ maxItems: undefined }), ticket: ticketOf(9) },
        node,
        state,
        records,
      ),
    ).toBe(undefined);
  });

  it("is a LimitError.Items that names where, the bound and the count, taken by the handler", () => {
    const handler = handlerFor(LimitError.Items, "report-action");
    const out = itemsOverflowOf(
      { launch: launchOf({}, [handler]), ticket: ticketOf(7) },
      node,
      state,
      records,
    );

    const failure = out?.failure as InstanceType<typeof LimitError.Items>;
    expect(failure).toBeInstanceOf(LimitError.Items);
    expect(failure.path).toStrictEqual(["start", "intake", "finder-agent"]);
    expect(failure.node).toBe("finder-agent");
    expect(failure.limit).toBe(3);
    expect(failure.actual).toBe(7);
    expect(failure.spentUsd).toBe(0);
    expect(out?.stoppedBy).toMatchObject({ next: "report-action" });
  });

  it("is the failure itself when no handler takes it", () => {
    expect(() =>
      itemsOverflowOf({ launch: launchOf(), ticket: ticketOf(7) }, node, state, records),
    ).toThrow(LimitError.Items);
  });
});

describe("where a launch's failure goes at dispatch", () => {
  const node = { id: "finder-agent" } as never;
  const state = { path: [], compensations: [] } as never;

  it("is the update of the handler's side path: the record, the next node, the handled error", () => {
    const error = new LimitError.Items({
      path: [],
      spentUsd: 0 as never,
      node: "n",
      limit: 1,
      actual: 2,
    });
    const update = joinErrorTaken(
      {
        launch: launchOf({}, [handlerFor(LimitError, "report-action")]),
        node,
        state,
        records: {} as never,
      },
      error,
    );

    expect(update).toStrictEqual({
      lastError: errorRecordOf(error),
      next: "report-action",
      handledErrors: [
        { handled: { error: errorRecordOf(error), at: "finder-agent", by: "report-action" } },
      ],
      sidePath: { entered: "report-action", record: errorRecordOf(error) },
    });
  });

  it("is the failure thrown when no handler's class matches", () => {
    const error = new StepError.Action({ action: "x-action" });

    expect(() =>
      joinErrorTaken(
        {
          launch: launchOf({}, [handlerFor(LimitError, "report-action")]),
          node,
          state,
          records: {} as never,
        },
        error,
      ),
    ).toThrow(error);
  });
});
