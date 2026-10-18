import { extractRunContext } from "../../../core/run-context.js";
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

/** What an action is: `execute(input)` (`implements ActionHandler<Self>`). */
interface ActionInstance {
  execute(input: Readonly<Record<string, unknown>>): Promise<unknown>;
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
    throw new OutputInvalidError(
      `${node} has output oneOf(${classes}) — return variant(XDto, value) with one of them`,
    );
  }
  return { dto, value: validate(dto, value) };
}

/** An action's result checked against its `output`, as the value its edge writes. */
function checkedValue(node: string, output: OutputShape, result: unknown): NodeValue {
  if (typeof output === "function") return { value: validate(output, result) };
  if (output.kind === Wrapper.OneOf) {
    const { dto, value } = variantOf(node, output, result);
    return { value, variant: dto.name };
  }
  if (!Array.isArray(result))
    throw new OutputInvalidError(`${node} has a list output — return an array`);
  const { element } = output;
  const items = (result as readonly unknown[]).map((item) => {
    if (typeof element === "function") return validate(element, item);
    const { dto, value } = variantOf(node, element, item);
    return { variant: dto.name, value };
  });
  return { value: items };
}

/** A failure of the action's code; a limit, a cancel or a pause passes as it is (S22). */
const failure = (node: string, error: unknown): unknown =>
  passesThrough(error) ? error : new ActionFailedError(node, error);

/**
 * An action: its instance from the container runs `execute(input)` with its fields from the scope;
 * the result is checked against its `output` (`variant(…)` for a `oneOf`); without `output` it gives
 * nothing. What it throws fails the step as `ActionFailedError` (the original as the cause).
 */
export function actionRunner(node: RuntimeNode, deps: GraphDeps<string>): NodeRunner {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Action) throw new TypeError(`${node.id} is not an action`);
  const { output } = declaration.options;
  return async (state, config) => {
    const instance: unknown = deps.container.get(node.component);
    if (!isAction(instance)) throw new OutputInvalidError(`${node.id} has no execute(input)`);
    const input = readInput(deps.graph, node, state);
    const { threadId } = extractRunContext(config, state.runId);
    const name = stepNodeIdOf(node);
    const appState = { runId: state.runId, threadId, activeNode: name };
    await deps.observer?.onActionStart({ name, input: input.fields, state: appState });
    const result = await instance.execute(input.fields).catch((error: unknown) => {
      throw failure(node.id, error);
    });
    await deps.observer?.onActionEnd({ name, update: result, state: appState });
    if (output === undefined) return { read: input.read };
    return { value: checkedValue(node.id, output, result), read: input.read };
  };
}
