import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { componentOf, requireComponent, type ToolMeta } from "../../components/metadata.js";
import { validate } from "../../dto/schema.js";
import { DEFAULT_TOOL_TIMEOUT, ToolTimeoutError } from "../../tools/index.js";
import { UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

/** What a tool class is: `run(input)` (`implements ToolHandler<…>`). */
export interface ToolInstance {
  run(input: never): Promise<unknown>;
}

/** A tool's input as `run` takes it: a plain object of its input DTO. */
export type ToolInputOf<TTool> = TTool extends { run(input: infer TInput): Promise<unknown> }
  ? TInput
  : never;

/** What a tool's `run` resolves to: its output DTO. */
export type ToolOutputOf<TTool> = TTool extends { run(input: never): Promise<infer TOutput> }
  ? TOutput
  : never;

/**
 * One tool, run as an agent's tool call runs it: `await runSearch({ q: "TS" }, { timeout })` →
 * `{ output, spend }`; the clock of its timeout as `runSearch.clock`.
 */
export interface ToolRunner<TInput, TOutput> extends UnitClock {
  (input: TInput, options?: UnitCallOptions): Promise<UnitRun<TOutput>>;
}

/** A tool's instance as the runner calls it: its validated input in, its result out. */
interface RunnableTool {
  run(input: object): Promise<unknown>;
}

const toolMetaOf = (tool: Class): ToolMeta =>
  componentOf(tool)?.kind === "mcp-tool"
    ? requireComponent(tool, "mcp-tool", "testTool").meta
    : requireComponent(tool, "tool", "testTool").meta;

/**
 * A `@Tool` (or `@McpTool`) on its own (#262 S55, S62): created by its own container (its `deps`,
 * `overrides` replacing classes, the `environment`); each call validates the input against its
 * input DTO, runs `run` in the frame of a tool call — `executionContext.signal` aborts after
 * `timeout` (default the tool's `timeout`) on the runner's clock, `SpendRecorder` records into
 * the call's `spend` as `tool:<name>` — and validates the output. A failure rejects as it was
 * thrown: the tool's own error, `ToolTimeoutError`, or `DtoValidationError` for an input or output
 * that does not fit.
 */
export function testTool<
  TTool extends Class<ToolInstance>,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  tool: TTool,
  options: UnitOptions<TExecution, TTenant> = {},
): ToolRunner<ToolInputOf<InstanceType<TTool>>, ToolOutputOf<InstanceType<TTool>>> {
  const meta = toolMetaOf(tool);
  const site = new UnitSite(options);
  const run = async (
    input: ToolInputOf<InstanceType<TTool>>,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<ToolOutputOf<InstanceType<TTool>>>> => {
    const valid = validate(meta.input, input);
    const delay = call.timeout ?? meta.timeout ?? DEFAULT_TOOL_TIMEOUT;
    const timeout = { delay, reason: (): Error => new ToolTimeoutError(delay) };
    const frame = { component: tool, caller: `tool:${meta.name}`, callId: "test-call", timeout };
    // the container creates the class itself: an instance of the tool, `run` included
    const instance = site.instanceOf(tool) as RunnableTool;
    return site.run(frame, async () => {
      const produced = await instance.run(valid);
      return validate(meta.output, produced) as ToolOutputOf<InstanceType<TTool>>;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
