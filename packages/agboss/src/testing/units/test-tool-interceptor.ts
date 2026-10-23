import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { componentOf, requireComponent, type ToolMeta } from "../../components/metadata.js";
import { validate } from "../../dto/schema.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import { toolInterceptorViolations } from "../../tool-interceptors/assembly.js";
import {
  isToolCallDecision,
  type AfterToolCall,
  type BeforeToolCall,
  type ToolCallContext,
  type ToolCallDecision,
} from "../../tool-interceptors/decision.js";
import { toolInterceptorMetaOf } from "../../tool-interceptors/decorator.js";
import type { ToolInterceptorInstance } from "../../tool-interceptors/runtime.js";
import { TestSetupError } from "../errors.js";
import type { ToolInputOf, ToolInstance, ToolOutputOf } from "./test-tool.js";
import { callTimeoutOf, UnitSite, type UnitFrame } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

const toolMetaOf = (tool: Class): ToolMeta =>
  componentOf(tool)?.kind === "mcp-tool"
    ? requireComponent(tool, "mcp-tool", "testToolInterceptor").meta
    : requireComponent(tool, "tool", "testToolInterceptor").meta;

/** The interceptor's name, its rules checked (`-tool-interceptor`, a method). */
function checkedNameOf(interceptor: Class): string {
  const meta = toolInterceptorMetaOf(interceptor);
  if (meta === undefined)
    throw new TestSetupError(`testToolInterceptor(${interceptor.name}): not a @ToolInterceptor`);
  throwIfViolated(toolInterceptorViolations(interceptor, meta));
  return meta.name;
}

/** The method the test calls; a class without it is a mistake in the test. */
function methodOf(
  interceptor: Class,
  instance: ToolInterceptorInstance,
  method: "beforeToolCall" | "afterToolCall",
): (call: unknown) => unknown {
  const found = instance[method];
  if (found === undefined)
    throw new TestSetupError(
      `testToolInterceptor(${interceptor.name}): it has no ${method}(call) — implements ${method === "beforeToolCall" ? "BeforeToolCall" : "AfterToolCall"}`,
    );
  return (call) => found.call(instance, call);
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
  ) => Promise<UnitRun<ToolCallDecision>>;
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
const contextOf = (tool: Class, input: unknown): ToolCallContext => ({
  tool: bareRecordOf(toolMetaOf(tool).name, ComponentKind.Tool),
  input,
});

/**
 * A `@ToolInterceptor` on its own (#384): its rules checked first (`-tool-interceptor`, a method),
 * created by its own container (its `deps`, `overrides`, the `environment`); each call runs in the
 * frame of a call to `tool` (`executionContext.step.callId`, the tenant and execution given), as in
 * an agent's loop. `beforeToolCall(Tool, input)` gives the decision — compare it with
 * `toEqual(ToolCallDecision.replyToModel({ message }))`; `afterToolCall(Tool, input, output)` the
 * output the model would read, validated against the tool's output DTO (`DtoValidationError`).
 */
export function testToolInterceptor<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  interceptor: Class<BeforeToolCall | AfterToolCall>,
  options: UnitOptions<TExecution, TTenant> = {},
): ToolInterceptorRunner {
  checkedNameOf(interceptor);
  const site = new UnitSite(options);
  const instance = (): ToolInterceptorInstance =>
    site.instanceOf(interceptor) as ToolInterceptorInstance;
  return {
    clock: site.clock,
    beforeToolCall: (tool, input, call = {}) => {
      const method = methodOf(interceptor, instance(), "beforeToolCall");
      return site.run(frameOf(tool, call), async () => {
        const decision = await method(contextOf(tool, input));
        if (isToolCallDecision(decision)) return decision;
        throw new TypeError(
          `${interceptor.name}.beforeToolCall returned no ToolCallDecision — return ToolCallDecision.allow(), .replyToModel({ message }) or .block({ reason })`,
        );
      });
    },
    afterToolCall: (tool, input, output, call = {}) => {
      const method = methodOf(interceptor, instance(), "afterToolCall");
      const { output: dto } = toolMetaOf(tool);
      return site.run(frameOf(tool, call), async () => {
        const given = validate(dto, output);
        const produced = await method({ ...contextOf(tool, input), output: given });
        return validate(dto, produced) as ToolOutputOf<InstanceType<typeof tool>>;
      });
    },
  };
}
