import { validate } from "../../../dto/schema.js";
import type { DtoClass } from "../../../dto/types.js";
import type { GraphDeps } from "../../../graph/deps.js";
import { NodeKind } from "../../ast.js";
import {
  Wrapper,
  variantClassOf,
  type OneOfWrapper,
  type OutputShape,
} from "../../dto-wrappers.js";
import type { RuntimeNode } from "../graph-model.js";
import type { NodeRunner } from "../node-runner.js";
import { stepNodeIdOf } from "../step-frame.js";
import { ActionFailedError, OutputInvalidError, passesThrough } from "../errors.js";
import { readInput, type NodeValue } from "../scope.js";
import { reportNodeEvent } from "../../observers/execution-event.js";
import { currentFrame } from "../../context/frame.js";
import { StepError } from "../../../core/error-families/step-errors.js";
import { stepCoordinatesOf } from "../../../graph/errors.js";
import { timeoutOn, type Clock } from "../../../infrastructure/clock.js";
import type { Milliseconds } from "../../../units/index.js";
import { ComponentKind } from "../records.js";

/** What an action is: `execute(input)` (`implements ActionHandler<Self>`). */
interface ActionInstance {
  execute(input: Readonly<Record<string, unknown>>): unknown;
}

const isAction = (value: unknown): value is ActionInstance =>
  typeof value === "object" &&
  value !== null &&
  "execute" in value &&
  typeof value.execute === "function";

/** A `oneOf` value names its class with `variant(XDto, value)`: never guessed from the shape. */
function variantOf(
  node: string,
  oneOf: OneOfWrapper,
  value: unknown,
): { dto: DtoClass; value: unknown } {
  const dto = variantClassOf(value);
  if (dto === undefined || !oneOf.variants.includes(dto)) {
    const classes = oneOf.variants.map((variant) => variant.name).join(", ");
    throw new OutputInvalidError({
      message: `${node} has output oneOf(${classes}) — return variant(XDto, value) with one of them`,
    });
  }
  return { dto, value: validate(dto, value) };
}

/** An action's result checked against its `output`, as the value its edge writes. */
export function checkedActionValue(node: string, output: OutputShape, result: unknown): NodeValue {
  if (typeof output === "function") return { value: validate(output, result) };
  if (output.kind === Wrapper.OneOf) {
    const { dto, value } = variantOf(node, output, result);
    return { value, variant: dto.name };
  }
  if (!Array.isArray(result))
    throw new OutputInvalidError({ message: `${node} has a list output — return an array` });
  const { element } = output;
  const items = (result as readonly unknown[]).map((item) => {
    if (typeof element === "function") return validate(element, item);
    const { dto, value } = variantOf(node, element, item);
    return { variant: dto.name, value };
  });
  return { value: items };
}

/**
 * The action's `execute`, sync or async: its result as a promise, a sync throw a rejection. With a
 * `timeout` the step fails with `StepError.ActionTimeout` when it runs past it (on the application's
 * clock); without one it waits as long as the action does.
 */
async function executed(
  run: () => unknown,
  node: string,
  timeout: Milliseconds | undefined,
  clock: Clock | undefined,
): Promise<unknown> {
  const result = Promise.resolve().then(run);
  if (timeout === undefined || clock === undefined) return result;
  const expired = timeoutOn(clock, timeout, () => timedOut(node, timeout));
  const late = new Promise<never>((_resolve, reject) => {
    expired.signal.addEventListener("abort", () => {
      reject(expired.signal.reason);
    });
  });
  try {
    return await Promise.race([result, late]);
  } finally {
    expired.release();
  }
}

const timedOut = (action: string, timeout: Milliseconds): StepError.ActionTimeout =>
  new StepError.ActionTimeout({
    ...stepCoordinatesOf(action, ComponentKind.Action),
    action,
    timeout,
    message: `Action "${action}" ran past its timeout of ${String(timeout)} ms`,
  });

/** A failure of the action's code; a limit, a cancel or a pause passes as it is (S22). */
const failure = (node: string, error: unknown): unknown =>
  passesThrough(error) || error instanceof StepError.ActionTimeout
    ? error
    : new ActionFailedError({ action: node, cause: error });

/**
 * An action: its instance from the container runs `execute(input)` with its fields from the scope;
 * the result is checked against its `output` (`variant(…)` for a `oneOf`); without `output` it gives
 * nothing. What it throws fails the step as `ActionFailedError` (the original as the cause). It
 * runs only while its holder holds the tree (#662, as an automatic undo's action, #640): the
 * holder's own fence is checked right before `execute`, after the awaited `onActionStart`.
 */
export function actionRunner(node: RuntimeNode, deps: GraphDeps<string>): NodeRunner {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Action) throw new TypeError(`${node.id} is not an action`);
  const { output, timeout } = declaration.options;
  return async (state) => {
    const instance: unknown = deps.container.get(node.component);
    if (!isAction(instance))
      throw new OutputInvalidError({ message: `${node.id} has no execute(input)` });
    const input = readInput(deps.graph, node, state);
    const name = stepNodeIdOf(node);
    await reportNodeEvent((base) =>
      deps.observer?.onActionStart({ ...base, name, input: input.fields }),
    );
    // #662: `onActionStart` is awaited (each event masked first, a model call with
    // `detectWithModel`): the holder's fence right before the action, nothing awaited in between —
    // a holder past its lease runs nothing (a hand-over: the new holder runs it)
    currentFrame()?.execution.lease?.assertHeld();
    const result = await executed(
      () => instance.execute(input.fields),
      node.id,
      timeout,
      deps.clock,
    ).catch((error: unknown) => {
      throw failure(node.id, error);
    });
    await reportNodeEvent((base) => deps.observer?.onActionEnd({ ...base, name, output: result }));
    if (output === undefined) return { read: input.read };
    return { value: checkedActionValue(node.id, output, result), read: input.read };
  };
}
