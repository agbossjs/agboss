import type { AnyTool, ToolInvocationContext, ToolOutput } from "../../tools/index.js";
import { FileError } from "../../core/error-families/remote-errors.js";
import { FileRefusal, FileUnavailableReason } from "../../files/file-errors.js";
import type { AgentLoopDeps } from "./deps.js";
import { runTool } from "./run-tool.js";
import type { ToolTask } from "./state.js";
import { questionResultOf } from "./tool-interception.js";

/** The error of arguments that are no input of the tool: paths and reasons only, never a value. */
export function invalidInputOf(tool: AnyTool, args: unknown): ToolOutput<unknown> {
  const checked = tool.input.safeParse(args);
  if (checked.success) return { kind: "error", message: "invalid input" };
  const issues = checked.error.issues.map(
    (issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
  );
  return { kind: "error", message: `invalid input: ${issues.join("; ")}` };
}

/**
 * What a call gives: the error of arguments that are no input of the tool, without running it
 * (#1295c); a question's (#712) without running the tool, else the tool's run.
 */
export const callOf = (
  tool: AnyTool,
  task: ToolTask,
  context: ToolInvocationContext,
  args: unknown,
): Promise<ToolOutput<unknown>> =>
  task.prepared.kind === "invalid" && tool.question === undefined
    ? Promise.resolve(invalidInputOf(tool, task.args))
    : questionResultOf(tool, task, () => runTool(tool, args, context));

/**
 * A tool's output with its inline files under the cap (#1316): offloaded to the file store, or
 * refused with no store — the model reads the refusal as the tool's error, never the bytes.
 */
export async function offloadedOutput(
  deps: Pick<AgentLoopDeps, "inlineFiles">,
  call: Promise<ToolOutput<unknown>>,
): Promise<ToolOutput<unknown>> {
  const output = await call;
  if (output.kind !== "ok" || deps.inlineFiles === undefined) return output;
  try {
    await deps.inlineFiles(output.value);
    return output;
  } catch (error) {
    // only the framework's own file refusals reach the model, as a fixed text; any other error (a
    // store's, with whatever its text holds) is the step's failure, never prompt text
    if (error instanceof FileError.Refused && error.refusal === FileRefusal.InlineTooLarge)
      return { kind: "error", message: INLINE_TOO_LARGE, cause: error };
    if (
      error instanceof FileError.Unavailable &&
      error.reason === FileUnavailableReason.DigestMismatch
    )
      return { kind: "error", message: DIGEST_MISMATCH, cause: error };
    throw error;
  }
}

const INLINE_TOO_LARGE = "the output's inline files are over the cap and no file store is listed";
const DIGEST_MISMATCH = "a file in the output does not match its digest or size";
