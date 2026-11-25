import { describe, expectTypeOf, it } from "vitest";
import { Action, type ActionOptions } from "../../src/flow/decorators/action.js";
import type { ExecuteMethod } from "../../src/flow/decorators/action.js";
import type { Milliseconds } from "../../src/units/index.js";

describe("#1318e: @Action", () => {
  it("execute is sync or async, with or without an input", () => {
    class Sync {
      execute(): string {
        return "x";
      }
    }
    class Async {
      execute(_input: { readonly a: string }): Promise<void> {
        return Promise.resolve();
      }
    }

    expectTypeOf<Sync>().toExtend<ExecuteMethod>();
    expectTypeOf<Async>().toExtend<ExecuteMethod>();
  });

  it("an action has an optional timeout, a Milliseconds; none by default", () => {
    expectTypeOf<ActionOptions["timeout"]>().toEqualTypeOf<Milliseconds | undefined>();
    // @ts-expect-error -- a timeout is Milliseconds, not a bare number
    const wrong: ActionOptions = { name: "a-action", description: "d", timeout: 5000 };
    expectTypeOf(wrong).toBeObject();
    expectTypeOf(Action).toBeFunction();
  });
});
