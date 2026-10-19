import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { NodeKind } from "../../flow/ast.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import type { ExecuteMethod } from "../../flow/decorators/action.js";
import { checkedActionValue } from "../../flow/runtime/runners/action.js";
import { TestSetupError } from "../errors.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

/** An action's input as `execute` takes it: its fields, plain objects (`Produced` records). */
export type ActionInputOf<TAction> = TAction extends { execute(input: infer TInput): unknown }
  ? TInput
  : never;

/** What an action's `execute` resolves to: its output, nothing without `output`. */
export type ActionOutputOf<TAction> = TAction extends { execute(input: never): infer TResult }
  ? Awaited<TResult>
  : never;

/** One action, run as its step runs it: `await runNotify({ draft })` → `{ output, spend }`. */
export interface ActionRunner<TInput, TOutput> extends UnitClock {
  (input: TInput, options?: UnitCallOptions): Promise<UnitRun<TOutput>>;
}

/** An action's instance as the runner calls it. */
interface ExecutableAction {
  execute(input: unknown): Promise<unknown>;
}

function actionOptionsOf(action: Class) {
  const declaration = declarationOf(action);
  if (declaration?.kind !== NodeKind.Action)
    throw new TestSetupError(`testAction(${action.name}): not an @Action`);
  return declaration.options;
}

/**
 * An `@Action` on its own (#262 S62, the shape of `testTool`): created by its own container (its
 * `deps`, `overrides`, the `environment`); each call runs `execute(input)` in the frame of its step
 * — `executionContext.signal` aborts after `timeout` on the runner's clock, `SpendRecorder`
 * records into the call's `spend` as `action:<name>` — and checks the result against its `output`
 * (`variant(XDto, value)` for a `oneOf`), as the flow does. The input is what `execute` takes: its
 * fields as plain objects. A failure rejects as it was thrown (`OutputInvalidError` /
 * `DtoValidationError` for a result that does not fit).
 */
export function testAction<
  TAction extends Class<ExecuteMethod>,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  action: TAction,
  options: UnitOptions<TExecution, TTenant> = {},
): ActionRunner<ActionInputOf<InstanceType<TAction>>, ActionOutputOf<InstanceType<TAction>>> {
  const { name, output } = actionOptionsOf(action);
  const site = new UnitSite(options);
  const run = async (
    input: ActionInputOf<InstanceType<TAction>>,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<ActionOutputOf<InstanceType<TAction>>>> => {
    const frame = { component: action, caller: `action:${name}`, ...callTimeoutOf(call.timeout) };
    // the container creates the class itself: an instance of the action, `execute` included
    const instance = site.instanceOf(action) as ExecutableAction;
    return site.run(frame, async () => {
      const result = await instance.execute(input);
      if (output !== undefined) checkedActionValue(name, output, result);
      return result as ActionOutputOf<InstanceType<TAction>>;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
