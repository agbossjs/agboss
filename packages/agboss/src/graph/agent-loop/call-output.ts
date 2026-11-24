import type { AnyTool, ToolInvocationContext, ToolOutput } from "../../tools/index.js";
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
