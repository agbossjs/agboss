import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { requireComponent, type ToolMeta } from "../../components/metadata.js";
import { validate } from "../../dto/schema.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import { toolInterceptorViolations } from "../../tool-interceptors/assembly.js";
import {
  decisionInputOf,
  isToolCallDecision,
  outcomeOf,
  ToolCallDecision,
  ToolCallOutcome,
  withToolType,
  type ToolCallContext,
} from "../../tool-interceptors/decision.js";
import { toolInterceptorMetaOf } from "../../tool-interceptors/decorator.js";
import { hooksOf, methodsOf } from "../../tool-interceptors/assembly.js";
import type { ToolInputOf, ToolOutputOf } from "../../tools/index.js";
import { TestSetupError } from "../errors.js";
import type { ToolInstance } from "./test-tool.js";
import { callTimeoutOf, UnitSite, type UnitFrame } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

const toolMetaOf = (tool: Class): ToolMeta => requireComponent(tool, "tool", "testUnit").meta;

/** The interceptor's name, its rules checked (`-tool-interceptor`, a method). */
function checkedNameOf(interceptor: Class): string {
  const meta = toolInterceptorMetaOf(interceptor);
  if (meta === undefined)
    throw new TestSetupError({
      message: `testUnit(${interceptor.name}): not a @ToolInterceptor`,
    });
  throwIfViolated(toolInterceptorViolations(interceptor, meta));
  return meta.name;
}

/**
 * One tool interceptor, called as an agent's loop calls it (#384): `beforeToolCall(Tool, input)` →
 * the decision, `afterToolCall(Tool, input, output)` → the output the model would read; the clock
 * of its timeouts as `runner.clock`.
 */
export interface ToolInterceptorRunner extends UnitClock {
  readonly beforeToolCall: <TTool extends Class<ToolInstance>>(
    tool: TTool,
    input: ToolInputOf<InstanceType<TTool>>,
    options?: UnitCallOptions,
  ) => Promise<UnitRun<ToolCallDecision<unknown>>>;
  readonly afterToolCall: <TTool extends Class<ToolInstance>>(
    tool: TTool,
    input: ToolInputOf<InstanceType<TTool>>,
    output: ToolOutputOf<InstanceType<TTool>>,
    options?: UnitCallOptions,
  ) => Promise<UnitRun<ToolOutputOf<InstanceType<TTool>>>>;
}

/** The frame of a call to `tool`, as an agent's loop gives it. */
const frameOf = (tool: Class, call: UnitCallOptions): UnitFrame => ({
  component: tool,
  caller: `tool:${toolMetaOf(tool).name}`,
  callId: "test-call",
  ...callTimeoutOf(call.timeout),
});

/** What an interceptor reads of a call to `tool`. */
const contextOf = (tool: Class, input: unknown): ToolCallContext =>
  withToolType(
    {
      tool: bareRecordOf(toolMetaOf(tool).name, ComponentKind.Tool),
      agent: bareRecordOf("test-agent", ComponentKind.Agent),
      callId: "test-call",
      input,
    },
    tool,
  );

/** An instance's method by name. */
const callOf = (instance: object, name: string): ((...args: unknown[]) => unknown) =>
  (Reflect.get(instance, name) as (...args: unknown[]) => unknown).bind(instance);

/** What the two phases of a runner work on: the class, its instance's site, its hooks. */
interface Runnable {
  readonly interceptor: Class;
  readonly site: UnitSite;
  readonly hooks: ReturnType<typeof hooksOf>;
  readonly methods: ReturnType<typeof methodsOf>;
}

const needs = (interceptor: Class, has: boolean, phase: string): void => {
  if (!has)
    throw new TestSetupError({
      message: `testUnit(${interceptor.name}): it has no ${phase} hook — add @BeforeTool(Tool) / @AfterTool(Tool), beforeAnyTool(call) or afterAnyTool(call)`,
    });
};

/** The before hooks on one call: `beforeAnyTool`, then the tool's method; the first end wins. */
async function decide(
  { interceptor, site, hooks, methods }: Runnable,
  tool: Class,
  input: unknown,
): Promise<ToolCallDecision<unknown>> {
  const self = site.instanceOf(interceptor) as object;
  const { input: dto } = toolMetaOf(tool);
  const steps: { name: string; any: boolean }[] = [];
  if (hooks.beforeAny) steps.push({ name: "beforeAnyTool", any: true });
  const own = methods.before.get(tool);
  if (own !== undefined) steps.push({ name: own, any: false });
  let current = input;
  let last: ToolCallDecision<unknown> = ToolCallDecision.allow();
  for (const { name, any } of steps) {
    const method = callOf(self, name);
    const produced = await (any
      ? method(contextOf(tool, current))
      : method.length === 0
        ? method()
        : method(validate(dto, current)));
    if (!isToolCallDecision(produced))
      throw new TypeError(
        `${interceptor.name}.${name} returned no ToolCallDecision — return ToolCallDecision.allow(), .allow({ input }), .reply(message) or .block(reason)`,
      );
    last = produced;
    if (outcomeOf(produced) !== ToolCallOutcome.Allow) return produced;
    current = decisionInputOf(produced) ?? current;
  }
  return last;
}

/** The after hooks on one call: the tool's method, then `afterAnyTool`, each output validated. */
async function rewrite(
  { interceptor, site, hooks, methods }: Runnable,
  tool: Class,
  input: unknown,
  output: unknown,
): Promise<unknown> {
  const self = site.instanceOf(interceptor) as object;
  const { input: inputDto, output: dto } = toolMetaOf(tool);
  let current: unknown = validate(dto, output);
  const own = methods.after.get(tool);
  if (own !== undefined)
    current = validate(
      dto,
      await callOf(self, own)(validate(dto, current), validate(inputDto, input)),
    );
  if (hooks.afterAny) {
    const call = withToolType({ ...contextOf(tool, input), output: current }, tool);
    current = validate(dto, await callOf(self, "afterAnyTool")(call));
  }
  return current;
}

/**
 * A `@ToolInterceptor` on its own (#384, #1295): its rules checked first, created by its own
 * container (its `deps`, `overrides`, the `environment`); each call runs in the frame of a call to
 * `tool` (`executionContext.step.callId`, the tenant and execution given), as in an agent's loop.
 * `beforeToolCall(Tool, input)` gives the decision — `beforeAnyTool` first, then the tool's
 * `@BeforeTool` method; compare it with `toEqual(ToolCallDecision.reply(message))` —,
 * `afterToolCall(Tool, input, output)` the output the model would read (the `@AfterTool` method,
 * then `afterAnyTool`), validated against the tool's output DTO (`DtoValidationError`). A phase the
 * class has no hook for at all is a mistake in the test (`TestSetupError`); one it has hooks for
 * but not for this tool passes the call through (`allow()`, the output unchanged).
 */
export function interceptorUnit<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(interceptor: Class, options: UnitOptions<TExecution, TTenant> = {}): ToolInterceptorRunner {
  checkedNameOf(interceptor);
  const site = new UnitSite(options);
  const runnable = {
    interceptor,
    site,
    hooks: hooksOf(interceptor),
    methods: methodsOf(interceptor),
  };
  const { hooks } = runnable;
  return {
    clock: site.clock,
    beforeToolCall: (tool, input, call = {}) => {
      needs(interceptor, hooks.before.length > 0 || hooks.beforeAny, "before");
      return site.run(frameOf(tool, call), () => decide(runnable, tool, input));
    },
    afterToolCall: (tool, input, output, call = {}) => {
      needs(interceptor, hooks.after.length > 0 || hooks.afterAny, "after");
      return site.run(
        frameOf(tool, call),
        async () =>
          (await rewrite(runnable, tool, input, output)) as ToolOutputOf<InstanceType<typeof tool>>,
      );
    },
  };
}
