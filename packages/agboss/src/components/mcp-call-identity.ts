import { createHash } from "node:crypto";
import { McpError } from "../core/error-families/remote-errors.js";
import { currentFrame } from "../flow/context/frame.js";

/** The calls a step has made so far without a key: the position of the next one (kept per frame). */
const keylessCalls = new WeakMap<object, number>();

/** The arguments as text with sorted keys: the same data is the same text, whatever its key order. */
function canonicalArguments(args: unknown): string {
  const sorted = (_key: string, value: unknown): unknown =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value;
  try {
    return JSON.stringify(args ?? null, sorted);
  } catch {
    throw new McpError.Contract();
  }
}

/**
 * The identity of one call (`_meta.callId` of an AGBoss server): made of the step's idempotency
 * key, the server, the tool and the call's `key` when it has one — an explicit key dedupes as it
 * always did. A call without a key is told apart by its position in the step (counted per frame, so
 * a step that runs again makes the same ones in the same order) and by its arguments: two calls of
 * one tool never share an identity or a ledger key, and the same position with other arguments is a
 * different call, never a replay. `undefined` outside a step.
 */
export function callIdOf(
  server: string,
  tool: string,
  key: string | undefined,
  args?: unknown,
): string | undefined {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return undefined;
  let position = "";
  if (key === undefined) {
    const next = keylessCalls.get(frame) ?? 0;
    keylessCalls.set(frame, next + 1);
    const digest = createHash("sha256").update(canonicalArguments(args)).digest("hex");
    position = `${String(next)}:${digest}`;
  }
  return createHash("sha256")
    .update([frame.step.idempotencyKey, server, tool, key ?? "", position].join("\u0000"))
    .digest("hex");
}
