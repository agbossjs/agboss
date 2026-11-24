import "../polyfills/symbol-metadata.js";
import type { Class } from "../components/injection.js";
import { METADATA_KEY } from "../polyfills/symbol-metadata.js";
import type { ToolHandlerClass } from "../components/decorators.js";
import type { ToolInputOf, ToolOutputOf, UnionToIntersection } from "../tools/index.js";
import type { ToolCallDecision } from "./decision.js";

/**
 * The target-bound hooks of a `@ToolInterceptor` (#1295): `@BeforeTool(OrderStatusTool)` decides on
 * one tool's call with its input DTO, `@AfterTool(OrderStatusTool)` reads or replaces its output.
 * Several tools in one decorator (`@BeforeTool(A, B)`) share one method: it takes the union of
 * their inputs and may rewrite the input only to what every one of them accepts. Which method
 * serves which tool is recorded in the class's decorator metadata, never read from a name or an
 * arity.
 */

/** Which phase a hook is of. */
export enum ToolHookPhase {
  Before = "before",
  After = "after",
}

/** One decorated method as recorded: its name, its phase and the tools it serves. */
export interface ToolHook {
  readonly phase: ToolHookPhase;
  readonly method: string;
  readonly tools: readonly Class[];
}

const hooks = new WeakMap<object, ToolHook[]>();

/** The tool classes a hook decorator takes: at least one `@Tool` / `@McpTool` class. */
export type ToolTargets = readonly [ToolHandlerClass, ...ToolHandlerClass[]];

/** What a `@BeforeTool` method is: the call's input in, the decision out. */
export type BeforeToolMethod<This, TTools extends ToolTargets> = (
  this: This,
  input: ToolInputOf<InstanceType<TTools[number]>>,
) =>
  | ToolCallDecision<UnionToIntersection<ToolInputOf<InstanceType<TTools[number]>>>>
  | Promise<ToolCallDecision<UnionToIntersection<ToolInputOf<InstanceType<TTools[number]>>>>>;

/** What an `@AfterTool` method is: the output (and the input of the call) in, the output out. */
export type AfterToolMethod<This, TTools extends ToolTargets> = (
  this: This,
  output: ToolOutputOf<InstanceType<TTools[number]>>,
  input: ToolInputOf<InstanceType<TTools[number]>>,
) =>
  | UnionToIntersection<ToolOutputOf<InstanceType<TTools[number]>>>
  | Promise<UnionToIntersection<ToolOutputOf<InstanceType<TTools[number]>>>>;

/** What a method decorator's context gives the recorder. */
interface HookContext {
  readonly name: string | symbol;
  readonly metadata: DecoratorMetadataObject | undefined;
}

function recorder(
  phase: ToolHookPhase,
  name: string,
  tools: readonly Class[],
): (value: unknown, context: HookContext) => void {
  return (_value, context) => {
    const { metadata } = context;
    if (metadata === undefined)
      throw new TypeError(
        `@${name} on ${String(context.name)}: decorator metadata is missing — import "@agboss/core" first`,
      );
    const recorded = hooks.get(metadata) ?? [];
    hooks.set(metadata, [...recorded, { phase, method: String(context.name), tools }]);
  };
}

/**
 * `@BeforeTool(OrderStatusTool) skip({ orderId }: OrderLookupDto): ToolCallDecision` — the method
 * deciding on the calls of those tools: `allow()`, `allow({ input })`, `reply(message)` or
 * `block(reason)`. A method taking the input gets the validated DTO (a call with invalid arguments
 * goes the tool's own way, to the model as an invalid-arguments error); a method taking none runs
 * before the validation.
 */
export function BeforeTool<const TTools extends ToolTargets>(
  ...tools: TTools
): <This>(
  value: BeforeToolMethod<This, TTools>,
  context: ClassMethodDecoratorContext<This, BeforeToolMethod<This, TTools>> & {
    readonly static: false;
  },
) => void {
  return recorder(ToolHookPhase.Before, "BeforeTool", tools);
}

/**
 * `@AfterTool(OrderStatusTool) strip({ status }: OrderStatusDto): OrderStatusDto` — the method
 * giving the output the model reads in place of the tool's, validated against the tool's output DTO.
 */
export function AfterTool<const TTools extends ToolTargets>(
  ...tools: TTools
): <This>(
  value: AfterToolMethod<This, TTools>,
  context: ClassMethodDecoratorContext<This, AfterToolMethod<This, TTools>> & {
    readonly static: false;
  },
) => void {
  return recorder(ToolHookPhase.After, "AfterTool", tools);
}

/**
 * The `@BeforeTool` / `@AfterTool` methods of an interceptor class, its parents' included (a
 * subclass keeps every hook its parent declares — a parent's blocking hook never stops running
 * silently); a subclass's hook on the same method name and phase replaces the parent's. Parents
 * first, in declaration order.
 */
export function toolHooksOf(cls: Class): readonly ToolHook[] {
  const chain: ToolHook[][] = [];
  for (
    let metadata: unknown = Reflect.get(cls, METADATA_KEY);
    typeof metadata === "object" && metadata !== null;
    metadata = Object.getPrototypeOf(metadata)
  ) {
    const own = hooks.get(metadata);
    if (own !== undefined) chain.unshift(own);
  }
  const merged = new Map<string, ToolHook>();
  for (const hook of chain.flat()) merged.set(`${hook.phase}:${hook.method}`, hook);
  return [...merged.values()];
}
