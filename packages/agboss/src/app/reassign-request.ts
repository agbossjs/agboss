import { KEY_TEXT_RULE_TEXT, keyTextRuleOf } from "../core/errors.js";
import { DtoValidationError, type DtoIssue } from "../dto/errors.js";
import type { ReassignPauseRequest } from "./types.js";

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

/** The assignees of a request, checked: one to 100 key's texts, none twice. */
function assigneesOf(given: unknown): readonly string[] {
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

/** The request as an untyped (JS) caller may pass it, checked: a pause id, its assignees, a reason. */
export function checked(request: unknown): ReassignPauseRequest {
  const read = (field: string): unknown =>
    typeof request === "object" && request !== null ? Reflect.get(request, field) : undefined;
  const pauseId = read("pauseId");
  const reason = read("reason");
  if (typeof pauseId !== "string" || pauseId === "")
    reject([{ path: ".pauseId", reason: "a pause's id is a non-empty text" }]);
  const assignees = assigneesOf(read("assignees"));
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON)
  )
    reject([
      {
        path: ".reason",
        reason: `a reason is a non-blank text of at most ${String(MAX_REASON)} characters`,
      },
    ]);
  return { pauseId, assignees, ...(reason === undefined ? {} : { reason }) };
}
