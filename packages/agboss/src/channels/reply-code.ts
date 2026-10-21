import type { UsageRecord } from "../finops/usage.js";
import { ReplyInterpretationKind, type ReplyInterpretation } from "./channel-role.decorator.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import type { ReplyInterpreterInput } from "./reply-reader.js";

/**
 * A reply read by a code interpreter (#267 S124 b): its `interpret(input)` returns
 * `ReplyInterpretation.understood(decision)` — the decision, validated by the reader — or
 * `ReplyInterpretation.notUnderstood({ reason })` — a decline with that reason, no error behind it. A
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
function isReplyInterpretation(value: unknown): value is ReplyInterpretation<unknown> {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === ReplyInterpretationKind.Understood) return "decision" in value;
  return value.kind === ReplyInterpretationKind.NotUnderstood && "reason" in value;
}

/** What a code interpreter's return gives: its decision, or why there is none. */
function interpretationOf(returned: unknown): Interpreted {
  if (!isReplyInterpretation(returned)) {
    const message =
      "interpret returned neither ReplyInterpretation.understood(…) nor ReplyInterpretation.notUnderstood(…)";
    return crashed(new TypeError(message), []);
  }
  return returned.kind === ReplyInterpretationKind.Understood
    ? { kind: "answered", answer: returned.decision, usage: [] }
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
