import type {
  ToolInterceptorChains,
  RuntimeToolInterceptor,
} from "../../tool-interceptors/runtime.js";
import type { AgentLoopDeps } from "./deps.js";
import type { ToolTask } from "./state.js";
import type { AnyTool, ToolOutput } from "../../tools/index.js";
import { before, after, InterceptorFailure, messageOf } from "./tool-hooks.js";
import { ToolCallStopKind, type ToolCallStop } from "./tool-stops.js";

/**
 * One tool call through its interceptors (#384, #1295), in the call's frame: for each interceptor in
 * list order (outer first) its `beforeAnyTool`, then its `@BeforeTool` method for this tool, on the
 * arguments as the tool gets them — PII revealed —; the first decision that is not `allow()` ends
 * the chain (`reply` → its message is the call's result, `block` → the step fails), an
 * `allow({ input })` replaces the arguments (validated against the tool's input again) for the hooks
 * after it and for the tool; then the tool; then, in reverse order (inner first), each
 * interceptor's `@AfterTool` method, then its `afterAnyTool`, on a successful result, each output
 * validated against the tool's output before the next reads it. A tool error goes to the model as
 * it is, past the after hooks. An interceptor that throws, returns no decision or an input or an
 * output its tool does not take stops the call: the step fails.
 */

/** What became of a call: the tool ran, an interceptor answered the model, or one stopped it. */
export type InterceptedCall =
  | { readonly kind: "ran"; readonly output: ToolOutput<unknown> }
  | { readonly kind: "replied"; readonly message: string }
  | { readonly kind: "stopped"; readonly stop: ToolCallStop };

/** Whose call it is: the agent's loop and the call's id. */
export interface InterceptedCallScope {
  readonly agent: string;
  readonly callId: string;
}

/** What the `before` hooks gave: the call's end, or the arguments the tool is to get. */
export type Before =
  | { readonly ended: Exclude<InterceptedCall, { readonly kind: "ran" }> }
  | { readonly ended?: undefined; readonly input: unknown };

/** What the `before` hooks decided: the arguments the tool is to get, or the call's end. */
export type BeforeCall =
  | { readonly kind: "proceed"; readonly input: unknown }
  | Exclude<InterceptedCall, { readonly kind: "ran" }>;

/** The failure of an interceptor as the call's stop; any other error goes on. */
function stoppedBy(error: unknown, keep: (error: unknown) => void): ToolCallStop {
  if (!(error instanceof InterceptorFailure)) throw error;
  keep(error.error);
  return {
    kind: ToolCallStopKind.Failed,
    interceptor: error.interceptor,
    reason: messageOf(error.error),
  };
}

/**
 * The `before` hooks of a call's chain (#1295c): run once, before the call is asked about, with
 * what they gave kept by the loop; `keep` keeps a failed interceptor's error for the step's failure.
 */
export async function beforeCall(
  chain: readonly RuntimeToolInterceptor[],
  tool: AnyTool,
  input: unknown,
  keep: (error: unknown) => void,
  scope: InterceptedCallScope,
): Promise<BeforeCall> {
  const [first] = chain;
  if (first === undefined) return { kind: "proceed", input };
  try {
    const decided = await before(chain, { tool, scope, type: first.toolType }, input);
    return decided.ended ?? { kind: "proceed", input: decided.input };
  } catch (error) {
    return { kind: "stopped", stop: stoppedBy(error, keep) };
  }
}

/** The `after` hooks of a call's chain on what its tool gave; a tool error goes on as it is. */
export async function afterCall(
  chain: readonly RuntimeToolInterceptor[],
  tool: AnyTool,
  call: { readonly input: unknown; readonly output: ToolOutput<unknown> },
  keep: (error: unknown) => void,
  scope: InterceptedCallScope,
): Promise<Extract<InterceptedCall, { readonly kind: "ran" | "stopped" }>> {
  const [first] = chain;
  const { output } = call;
  if (first === undefined || output.kind === "error") return { kind: "ran", output };
  try {
    const site = { tool, scope, type: first.toolType };
    const value = await after(chain, site, call.input, output.value);
    return { kind: "ran", output: { kind: "ok", value } };
  } catch (error) {
    return { kind: "stopped", stop: stoppedBy(error, keep) };
  }
}

/** The call through its whole chain: `before` hooks, the tool, `after` hooks. */
export async function interceptedCall(
  chain: readonly RuntimeToolInterceptor[],
  tool: AnyTool,
  input: unknown,
  run: (input: unknown) => Promise<ToolOutput<unknown>>,
  keep: (error: unknown) => void,
  scope: InterceptedCallScope,
): Promise<InterceptedCall> {
  const decided = await beforeCall(chain, tool, input, keep, scope);
  if (decided.kind !== "proceed") return decided;
  const output = await run(decided.input);
  return afterCall(chain, tool, { input: decided.input, output }, keep, scope);
}

/** A call's tool interceptors: a question call (#712) runs no tool, its answer was asked already. */
export const interceptorsOf = (
  deps: Pick<AgentLoopDeps, "interceptors">,
  tool: AnyTool,
): ReturnType<ToolInterceptorChains> =>
  tool.question === undefined ? (deps.interceptors?.(tool.name) ?? []) : [];

/**
 * A question call's result (#712): its answer — asked before the move's tools ran, validated —, or
 * why its arguments asked nobody; any other call (or a question with no pause seam) is `run`.
 */
export function questionResultOf(
  tool: AnyTool,
  task: ToolTask,
  run: () => Promise<ToolOutput<unknown>>,
): Promise<ToolOutput<unknown>> {
  if (tool.question === undefined) return run();
  if (task.invalidAsk !== undefined)
    return Promise.resolve({ kind: "error", message: task.invalidAsk });
  return "answer" in task ? Promise.resolve({ kind: "ok", value: task.answer }) : run();
}
