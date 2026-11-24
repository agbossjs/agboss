import type { UsageRecord } from "../finops/usage.js";
import { ChannelInterpretationKind, type ChannelInterpretation } from "./channel-interpreter.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import type { ReplyInterpreterInput } from "./reply-reader.js";

/**
 * A reply read by a code interpreter (#267 S124 b): its `interpret(input)` returns
 * `ChannelInterpretation.understood(output)` — the output, validated by the reader — or
 * `ChannelInterpretation.notUnderstood(reason)` — a decline with that reason, no error behind it. A
 * throw is a crash: a decline whose `cause` is the thrown error; so is a value that is neither
 * outcome (a JS interpreter's plain object). Sync or a promise, either is awaited.
 */

/** Why the interpreter gave no answer, and what it cost. */
export interface Declined {
  readonly kind: "declined";
  readonly reason: string;
  /** The error behind it: a crash's, an invalid answer's; none for a decline. */
  readonly cause?: unknown;
  readonly usage: readonly UsageRecord[];
}

/** What the interpreter itself answered, before validation. */
export type Interpreted =
  | { readonly kind: "answered"; readonly answer: unknown; readonly usage: readonly UsageRecord[] }
  | Declined;

/** A crash of the interpreter (or its answer's validation): its message is the reason. */
export const crashed = (cause: unknown, usage: readonly UsageRecord[]): Declined => ({
  kind: "declined",
  reason: cause instanceof Error ? cause.message : String(cause),
  cause,
  usage,
});

/** Whether `interpret` returned an interpretation (a JS caller may return anything). */
function isChannelInterpretation(value: unknown): value is ChannelInterpretation<unknown> {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === ChannelInterpretationKind.Understood) return "output" in value;
  return value.kind === ChannelInterpretationKind.NotUnderstood && "reason" in value;
}

/** What a code interpreter's return gives: its decision, or why there is none. */
function interpretationOf(returned: unknown): Interpreted {
  if (!isChannelInterpretation(returned)) {
    const message =
      "interpret returned neither ChannelInterpretation.understood(…) nor ChannelInterpretation.notUnderstood(…)";
    return crashed(new TypeError(message), []);
  }
  return returned.kind === ChannelInterpretationKind.Understood
    ? { kind: "answered", answer: returned.output, usage: [] }
    : { kind: "declined", reason: returned.reason, usage: [] };
}

/** One reading of `input` by a code interpreter: its `instance`, the container's or a test's mock. */
export async function readByCode(
  interpreter: AssembledReplyInterpreter,
  input: ReplyInterpreterInput,
  instance: unknown,
): Promise<Interpreted> {
  const interpret: unknown =
    typeof instance === "object" && instance !== null
      ? Reflect.get(instance, "interpret")
      : undefined;
  if (typeof interpret !== "function")
    throw new TypeError(`${interpreter.name}: interpret is not a method`);
  try {
    return interpretationOf(await Reflect.apply(interpret, instance, [input]));
  } catch (cause) {
    // an unexpected crash: the reply stays unread, the thrown error its cause
    return crashed(cause, []);
  }
}
