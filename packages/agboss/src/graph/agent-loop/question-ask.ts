import { pathOf } from "../../dto/errors.js";
import type { AnyTool } from "../../tools/index.js";

/** A question call's arguments read as the role's ask: valid, or why not. */
export type CheckedAsk =
  | { readonly kind: "valid"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "invalid"; readonly problem: string };

/**
 * The model's arguments as the role's `ask` — the question tool's input is strict, so a field the
 * ask does not declare is refused too, never passed on to whoever answers. The problem names paths
 * and reasons, never a value.
 */
export function askOf(tool: AnyTool, args: Readonly<Record<string, unknown>>): CheckedAsk {
  const parsed = tool.input.safeParse(args);
  // Stryker disable next-line StringLiteral: equivalent: the kind is only ever compared with "invalid", so any other text is the valid one
  if (parsed.success) return { kind: "valid", value: parsed.data as Record<string, unknown> };
  const issues = parsed.error.issues.map((issue) => `${pathOf(issue.path)}: ${issue.message}`);
  return { kind: "invalid", problem: `invalid input: ${issues.join("; ")}` };
}
