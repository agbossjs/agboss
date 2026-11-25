import { definedFields } from "../core/defined-fields.js";
import { KEY_TEXT_RULE_TEXT, keyTextRuleOf } from "../core/errors.js";
import { DtoValidationError, type DtoIssue } from "../dto/errors.js";
import { isPauseTimeout } from "../channels/channel-rules.js";
import type { Class } from "../components/injection.js";
import { spanText } from "../units/working-time.js";
import type { ReassignPauseRequest } from "./reassign-types.js";

/** The checks of a reassignment's request (#946, #1307d): split from `pause-reassignment.ts`. */

export function reject(issues: readonly DtoIssue[]): never {
  throw new DtoValidationError({ dto: "ReassignPauseRequest", issues });
}

/** The most assignees one reassignment names. */
export const MAX_ASSIGNEES = 100;
/** The longest reason, in characters. */
export const MAX_REASON = 500;

/** The problem of one assignee: a key's text (#589), non-empty; `undefined` when it is one. */
function assigneeProblem(assignee: unknown): string | undefined {
  if (typeof assignee !== "string") return "an assignee is a key's text: a non-empty text";
  const rule = keyTextRuleOf(assignee);
  return rule === undefined
    ? undefined
    : `an assignee is a key's text (${rule}): ${KEY_TEXT_RULE_TEXT[rule]}`;
}

/**
 * The assignees of a request, checked: one to 100 key's texts, none twice. An expiry's list has
 * at least one; a call's may be empty (`allowEmpty`: it releases the pause back to nobody).
 */
export function assigneesOf(given: unknown, allowEmpty = false): readonly string[] {
  if (allowEmpty && Array.isArray(given) && given.length === 0) return [];
  if (!Array.isArray(given) || given.length === 0 || given.length > MAX_ASSIGNEES)
    return reject([
      {
        path: ".assignees",
        reason: `assignees are a list of one to ${String(MAX_ASSIGNEES)} key's texts`,
      },
    ]);
  const list = given as readonly unknown[];
  list.forEach((assignee, index) => {
    const problem = assigneeProblem(assignee);
    if (problem !== undefined) reject([{ path: `.assignees[${String(index)}]`, reason: problem }]);
  });
  if (new Set(list).size !== list.length)
    reject([{ path: ".assignees", reason: "an assignee is named once" }]);
  return list as readonly string[];
}

/** What a request names besides the pause: a class, or nothing. */
function classOf(request: unknown, field: "target" | "channel"): Class | undefined {
  const given: unknown =
    typeof request === "object" && request !== null ? Reflect.get(request, field) : undefined;
  if (given === undefined) return undefined;
  if (typeof given !== "function")
    return reject([{ path: `.${field}`, reason: `the ${field} is a class, as decorated` }]);
  return given as Class;
}

/** What a request holds under `field`, when it is an object. */
const readOf = (request: unknown, field: string): unknown =>
  typeof request === "object" && request !== null ? Reflect.get(request, field) : undefined;

/** The request's `timeout`, checked: a duration or nothing. */
function timeoutOf(request: unknown): ReassignPauseRequest["timeout"] {
  const timeout = readOf(request, "timeout");
  if (timeout !== undefined && !isPauseTimeout(timeout))
    reject([
      {
        path: ".timeout",
        reason: `${spanText(timeout)} is no duration — a positive finite one of at least seconds(1), like hours(24) or workHours(8)`,
      },
    ]);
  return timeout;
}

/** The request's `reason`, checked: a non-blank text of at most `MAX_REASON` characters, or nothing. */
function reasonOf(request: unknown): string | undefined {
  const reason = readOf(request, "reason");
  if (reason === undefined) return undefined;
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON)
    reject([
      {
        path: ".reason",
        reason: `a reason is a non-blank text of at most ${String(MAX_REASON)} characters`,
      },
    ]);
  return reason;
}

/** The request as an untyped (JS) caller may pass it, checked: a pause id, where to, who for, how long, a reason. */
export function checked(request: unknown): ReassignPauseRequest {
  const pauseId = readOf(request, "pauseId");
  if (typeof pauseId !== "string" || pauseId === "")
    reject([{ path: ".pauseId", reason: "a pause's id is a non-empty text" }]);
  const given = readOf(request, "assignees");
  return {
    pauseId,
    ...definedFields({
      assignees: given === undefined ? undefined : assigneesOf(given, true),
      timeout: timeoutOf(request),
      target: classOf(request, "target"),
      channel: classOf(request, "channel"),
      reason: reasonOf(request),
    }),
  };
}
