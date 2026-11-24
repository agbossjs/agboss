import { describe, expectTypeOf, it } from "vitest";
import * as builder from "../../../src/flow/builder.js";
import type { PathSource } from "../../../src/flow/ast.js";
import type { PathBuilder } from "../../../src/flow/path-builder.js";
import * as core from "../../../src/index.js";
import * as flow from "../../../src/public/flow.js";

/**
 * #1262 / #1273 — every root path of a flow begins with `on<Kind>(…)` and every forward step is
 * `to<Kind>(…)`: `onStart`, `onAgent`, `onAction`, `onRouter`, `onExternalTask`, `onWorkflow`, and
 * `toExternalTask` for the question role's step. The bare nouns and `toQuestion` are gone.
 */
describe("#1262 / #1273: the entries of a path", () => {
  it("the on<Kind> entries and toExternalTask are functions on the builder, the flow barrel and the root", () => {
    expectTypeOf(builder.onStart).toBeFunction();
    expectTypeOf(builder.onAgent).toBeFunction();
    expectTypeOf(builder.onAction).toBeFunction();
    expectTypeOf(builder.onRouter).toBeFunction();
    expectTypeOf(builder.onExternalTask).toBeFunction();
    expectTypeOf(builder.onWorkflow).toBeFunction();
    expectTypeOf(builder.toExternalTask).toBeFunction();
    expectTypeOf(flow.onStart).toEqualTypeOf<typeof builder.onStart>();
    expectTypeOf(flow.onAgent).toEqualTypeOf<typeof builder.onAgent>();
    expectTypeOf(flow.onExternalTask).toEqualTypeOf<typeof builder.onExternalTask>();
    expectTypeOf(core.onStart).toEqualTypeOf<typeof builder.onStart>();
    expectTypeOf(core.onWorkflow).toEqualTypeOf<typeof builder.onWorkflow>();
    expectTypeOf(core.toExternalTask).toEqualTypeOf<typeof builder.toExternalTask>();
  });

  it("a path continues with .toExternalTask, not .toQuestion", () => {
    expectTypeOf<PathBuilder<PathSource>["toExternalTask"]>().toBeFunction();
    // @ts-expect-error — the method is `toExternalTask` (#1273)
    expectTypeOf<PathBuilder<PathSource>["toQuestion"]>();
  });

  it("the bare nouns and toQuestion are gone from the builder, the flow barrel and the root", () => {
    // @ts-expect-error — `start` is `onStart` (#1262)
    expectTypeOf(builder.start);
    // @ts-expect-error — `agent` is `onAgent` (#1273)
    expectTypeOf(builder.agent);
    // @ts-expect-error — `action` is `onAction` (#1273)
    expectTypeOf(builder.action);
    // @ts-expect-error — `router` is `onRouter` (#1273)
    expectTypeOf(builder.router);
    // @ts-expect-error — `question` is `onExternalTask` (#1273)
    expectTypeOf(builder.question);
    // @ts-expect-error — `workflow` is `onWorkflow` (#1273)
    expectTypeOf(builder.workflow);
    // @ts-expect-error — `toQuestion` is `toExternalTask` (#1273)
    expectTypeOf(builder.toQuestion);
    // @ts-expect-error — `start` is `onStart` (#1262)
    expectTypeOf(flow.start);
    // @ts-expect-error — `toQuestion` is `toExternalTask` (#1273)
    expectTypeOf(flow.toQuestion);
    // @ts-expect-error — `start` is `onStart` (#1262)
    expectTypeOf(core.start);
    // @ts-expect-error — `agent` is `onAgent` (#1273)
    expectTypeOf(core.agent);
    // @ts-expect-error — `toQuestion` is `toExternalTask` (#1273)
    expectTypeOf(core.toQuestion);
  });
});
