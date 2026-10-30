import { handedOverOf, recordedHandOver } from "../../app/handed-over.js";
import { HandOverSite } from "../../infrastructure/execution-lease-event.repository.js";
import { DtoValidationError, pathOf } from "../../dto/errors.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import {
  decisionTextOf,
  isToolCallDecision,
  outcomeOf,
  ToolCallOutcome,
  type ToolCallContext,
} from "../../tool-interceptors/decision.js";
import type { RuntimeToolInterceptor } from "../../tool-interceptors/runtime.js";
import type { AnyTool, ToolOutput } from "../../tools/index.js";
import { ToolCallStopKind, type ToolCallStop } from "./tool-stops.js";

/**
 * One tool call through its interceptors (#384), in the call's frame: each `beforeToolCall` in list
 * order (outer first) on the arguments as the tool gets them — PII revealed —, the first decision
 * that is not `allow()` ends the chain (`replyToModel` → its message is the call's result,
 * `block` → the step fails); then the tool; then each `afterToolCall` in reverse order (inner
 * first) on a successful result, each output validated against the tool's output before the next
 * reads it. A tool error goes to the model as it is, past the `afterToolCall`s. An interceptor that
 * throws, returns no decision or an output its tool does not give stops the call: the step fails.
 */

/** What became of a call: the tool ran, an interceptor answered the model, or one stopped it. */
export type InterceptedCall =
  | { readonly kind: "ran"; readonly output: ToolOutput<unknown> }
  | { readonly kind: "replied"; readonly message: string }
  | { readonly kind: "stopped"; readonly stop: ToolCallStop };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A failure of one interceptor: what the step's error carries. */
class InterceptorFailure extends Error {
  override name = "InterceptorFailure";

  constructor(
    readonly interceptor: string,
    readonly error: unknown,
  ) {
    super(messageOf(error));
  }
}

/** One interceptor's method, its failure wrapped with its name. */
async function called(interceptor: RuntimeToolInterceptor, work: () => unknown): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    // a fenced write of an interceptor (#471) is a hand-over, never the interceptor's failure
    const handedOver = handedOverOf(error, undefined);
    if (handedOver !== undefined) throw recordedHandOver(handedOver, HandOverSite.ToolInterceptor);
    throw new InterceptorFailure(interceptor.name, error);
  }
}

/** The `beforeToolCall`s, outer first: the first decision that is not `allow()`, if any. */
async function before(
  chain: readonly RuntimeToolInterceptor[],
  call: ToolCallContext,
): Promise<InterceptedCall | undefined> {
  for (const interceptor of chain) {
    const method = interceptor.instance.beforeToolCall;
    if (method === undefined) continue;
    const decision = await called(interceptor, () => method.call(interceptor.instance, call));
    if (!isToolCallDecision(decision))
      throw new InterceptorFailure(
        interceptor.name,
        new TypeError(
          "beforeToolCall returned no ToolCallDecision — return ToolCallDecision.allow(), .replyToModel({ message }) or .block({ reason })",
        ),
      );
    const outcome = outcomeOf(decision);
    if (outcome === ToolCallOutcome.ReplyToModel)
      return { kind: "replied", message: decisionTextOf(decision) };
    if (outcome === ToolCallOutcome.Block) {
      const stop = { kind: ToolCallStopKind.Blocked, interceptor: interceptor.name };
      return { kind: "stopped", stop: { ...stop, reason: decisionTextOf(decision) } };
    }
  }
  return undefined;
}

/** The `afterToolCall`s, inner first, each output validated against the tool's output. */
async function after(
  chain: readonly RuntimeToolInterceptor[],
  tool: AnyTool,
  call: ToolCallContext,
  output: unknown,
): Promise<unknown> {
  let current = output;
  for (const interceptor of [...chain].reverse()) {
    const method = interceptor.instance.afterToolCall;
    if (method === undefined) continue;
    const given = { ...call, output: current };
    const produced = await called(interceptor, () => method.call(interceptor.instance, given));
    const parsed = tool.output.safeParse(produced);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: pathOf(issue.path),
        reason: issue.message,
      }));
      throw new InterceptorFailure(
        interceptor.name,
        new DtoValidationError(`${tool.name} output from afterToolCall`, issues),
      );
    }
    current = parsed.data;
  }
  return current;
}

/** The call through its chain; `keep` keeps a failed interceptor's error for the step's failure. */
export async function interceptedCall(
  chain: readonly RuntimeToolInterceptor[],
  tool: AnyTool,
  input: unknown,
  run: () => Promise<ToolOutput<unknown>>,
  keep: (error: unknown) => void,
): Promise<InterceptedCall> {
  if (chain.length === 0) return { kind: "ran", output: await run() };
  const call = { tool: bareRecordOf(tool.name, ComponentKind.Tool), input };
  try {
    const decided = await before(chain, call);
    if (decided !== undefined) return decided;
    const output = await run();
    if (output.kind === "error") return { kind: "ran", output };
    return {
      kind: "ran",
      output: { kind: "ok", value: await after(chain, tool, call, output.value) },
    };
  } catch (error) {
    if (!(error instanceof InterceptorFailure)) throw error;
    keep(error.error);
    const stop = { kind: ToolCallStopKind.Failed, interceptor: error.interceptor };
    return { kind: "stopped", stop: { ...stop, reason: messageOf(error.error) } };
  }
}
