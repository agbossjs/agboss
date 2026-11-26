import { ComponentKind } from "../../flow/runtime/records.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import {
  declarationOf,
  type InputFieldShape,
  type InputFields,
} from "../../flow/decorators/declaration.js";
import type { ExecuteMethod } from "../../flow/decorators/action.js";
import { Metadata, type Untracked } from "../../flow/metadata.js";
import { hydrated } from "../../dto/hydrate.js";
import { hydratedForShape } from "../../flow/runtime/shape-hydration.js";
import { checkedActionValue } from "../../flow/runtime/runners/action.js";
import { Wrapper } from "../../flow/dto-wrappers.js";
import { TestSetupError } from "../errors.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

/** An action's input as `execute` takes it: its fields, tracked DTOs. */
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
  if (declaration?.kind !== ComponentKind.Action)
    throw new TestSetupError({ message: `testUnit(${action.name}): not an @Action` });
  return declaration.options;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * A DTO a test gives, as the flow hands it over: tracked. One that `Metadata.with(…)` already
 * tracked keeps its facts; a plain one gets the default (the action under test as its creator, the
 * field as its slot), so `Metadata.of(input.x)` is defined inside the handler.
 */
function trackedItem(value: unknown, site: TrackSite, index?: number): unknown {
  if (!isRecord(value) || Metadata.has(value)) return value;
  return Metadata.with(value, {
    createdBy: site.component,
    slot: site.field,
    ...(index === undefined ? {} : { itemIndex: index }),
  });
}

interface TrackSite {
  readonly component: Class;
  readonly field: string;
}

/** A field's value hydrated by the field's shape (#1288) and tracked, as its step hands it over. */
function hydratedField(shape: InputFieldShape, value: unknown, site: TrackSite): unknown {
  if (typeof shape !== "function" && shape.kind === Wrapper.History) {
    if (!isRecord(value) || !Array.isArray(value.previous)) return value;
    const version = (item: unknown, index?: number): unknown =>
      trackedItem(typeof item === "object" ? hydrated(shape.dto, item) : item, site, index);
    return {
      current: version(value.current),
      previous: (value.previous as readonly unknown[]).map((item, index) => version(item, index)),
    };
  }
  const hydratedValue = hydratedForShape(shape, value);
  return Array.isArray(hydratedValue)
    ? (hydratedValue as readonly unknown[]).map((item, index) => trackedItem(item, site, index))
    : trackedItem(hydratedValue, site);
}

/** The input's fields as the flow hands them over: instances of their classes (#1288), tracked. */
function hydratedInputOf(
  shapes: InputFields | undefined,
  input: unknown,
  component: Class,
): unknown {
  if (shapes === undefined || typeof input !== "object" || input === null) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const shape = shapes[key];
      return [
        key,
        shape === undefined ? value : hydratedField(shape, value, { component, field: key }),
      ];
    }),
  );
}

/**
 * An `@Action` on its own (#262 S62, the shape of `testUnit`): created by its own container (its
 * `deps`, `overrides`, the `environment`); each call runs `execute(input)` in the frame of its step
 * — `executionContext.signal` aborts after `timeout` on the runner's clock, `SpendRecorder`
 * records into the call's `spend` as `action:<name>` — and checks the result against its `output`
 * as the flow does. The input is what `execute` takes, plain (`Untracked`): its
 * fields as DTOs, tracked by default. A failure rejects as it was thrown (`ExecutionError.OutputInvalid` /
 * `ValidationError.DtoInvalid` for a result that does not fit).
 */
export function actionUnit<
  TAction extends Class<ExecuteMethod>,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  action: TAction,
  options: UnitOptions<TExecution, TTenant> = {},
): ActionRunner<
  Untracked<ActionInputOf<InstanceType<TAction>>>,
  ActionOutputOf<InstanceType<TAction>>
> {
  const { name, output, input: shapes } = actionOptionsOf(action);
  const site = new UnitSite(options);
  const run = async (
    input: Untracked<ActionInputOf<InstanceType<TAction>>>,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<ActionOutputOf<InstanceType<TAction>>>> => {
    const frame = { component: action, caller: `action:${name}`, ...callTimeoutOf(call.timeout) };
    // the container creates the class itself: an instance of the action, `execute` included
    const instance = site.instanceOf(action) as ExecutableAction;
    return site.run(frame, async () => {
      const result = await instance.execute(hydratedInputOf(shapes, input, action));
      if (output !== undefined) checkedActionValue(name, output, result);
      return result as ActionOutputOf<InstanceType<TAction>>;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
