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

/** The call through its chain; `keep` keeps a failed interceptor's error for the step's failure. */
export async function interceptedCall(
  chain: readonly RuntimeToolInterceptor[],
  tool: AnyTool,
  input: unknown,
  run: (input: unknown) => Promise<ToolOutput<unknown>>,
  keep: (error: unknown) => void,
  scope: InterceptedCallScope,
): Promise<InterceptedCall> {
  const [first] = chain;
  if (first === undefined) return { kind: "ran", output: await run(input) };
  const site = { tool, scope, type: first.toolType };
  try {
    const decided = await before(chain, site, input);
    if (decided.ended !== undefined) return decided.ended;
    const output = await run(decided.input);
    if (output.kind === "error") return { kind: "ran", output };
    return {
      kind: "ran",
      output: { kind: "ok", value: await after(chain, site, decided.input, output.value) },
    };
  } catch (error) {
    if (!(error instanceof InterceptorFailure)) throw error;
    keep(error.error);
    const stop = { kind: ToolCallStopKind.Failed, interceptor: error.interceptor };
    return { kind: "stopped", stop: { ...stop, reason: messageOf(error.error) } };
  }
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
