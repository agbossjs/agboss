import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { requireComponent, type ToolMeta } from "../../components/metadata.js";
import { validate } from "../../dto/schema.js";
import {
  DEFAULT_TOOL_TIMEOUT,
  ToolTimeoutError,
  type ToolInputOf,
  type ToolOutputOf,
} from "../../tools/index.js";
import { UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

/** What a tool class is: `execute(input)`. */
export interface ToolInstance {
  execute(input: never): unknown;
}

/**
 * One tool, run as an agent's tool call runs it: `await runSearch({ q: "TS" }, { timeout })` →
 * `{ output, spend }`; the clock of its timeout as `runSearch.clock`.
 */
export interface ToolRunner<TInput, TOutput> extends UnitClock {
  (input: TInput, options?: UnitCallOptions): Promise<UnitRun<TOutput>>;
}

/** A tool's instance as the runner calls it: its validated input in, its result out. */
interface RunnableTool {
  execute(input: object): unknown;
}

const toolMetaOf = (tool: Class): ToolMeta => requireComponent(tool, "tool", "testUnit").meta;

/**
 * A `@Tool` on its own (#262 S55, S62): created by its own container (its `deps`,
 * `overrides` replacing classes, the `environment`); each call validates the input against its
 * input DTO, runs `execute` in the frame of a tool call — `executionContext.signal` aborts after
 * `timeout` (default the tool's `timeout`) on the runner's clock, `SpendRecorder` records into
 * the call's `spend` as `tool:<name>` — and validates the output. A failure rejects as it was
 * thrown: the tool's own error, `ToolTimeoutError`, or `ValidationError.DtoInvalid` for an input or output
 * that does not fit.
 */
export function toolUnit<
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
    const timeout = { delay, reason: (): Error => new ToolTimeoutError({ timeout: delay }) };
    const frame = { component: tool, caller: `tool:${meta.name}`, callId: "test-call", timeout };
    // the container creates the class itself: an instance of the tool, `execute` included
    const instance = site.instanceOf(tool) as RunnableTool;
    return site.run(frame, async () => {
      const produced = await instance.execute(valid);
      return validate(meta.output, produced) as ToolOutputOf<InstanceType<TTool>>;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
