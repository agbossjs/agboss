import { PauseError } from "../../core/error-families/pause-errors.js";
import { isPauseTimeout } from "../../channels/channel-rules.js";
import type { PauseTrailEntry, PauseToolCallSummary } from "../../channels/pause-contexts.js";
import { KEY_TEXT_RULE_TEXT, keyTextRuleOf } from "../../core/key-text-rule.js";
import { isWorkingDuration } from "../../units/index.js";
import type { TimeSpan } from "../../units/working-time.js";
import type { PauseTarget } from "./pause-channel.js";

/**
 * The hooks of a pause target that run when its pause is opened (#1307): `assign` (who the pause is
 * for) and `resolveTimeout` (how long this pause waits). Their failures and their invalid answers
 * stop the opening with an error that names the target and the problem, never the hook's text or the
 * pause's data; nothing is recorded, so the step's re-entry asks again.
 */

/** The most assignees one pause is for. */
export const MAX_ASSIGNEES = 100;

/** Why a target's hook could not open a pause: names the target and the problem, never the pause's data. */
export class PauseHookError extends Error {
  override name = "PauseHookError";

  constructor(target: string, problem: string, options?: ErrorOptions) {
    super(`pause target ${target}: ${problem}`, options);
  }
}

/** What `assign` and `resolveTimeout` read of the pause being opened. */
export interface OpeningFacts {
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolCall?: PauseToolCallSummary | undefined;
  readonly trail: readonly PauseTrailEntry[];
}

/** The problem of a list of assignees: one to 100 key's texts, none twice; `undefined` when it is one. */
export function assigneesProblemOf(given: unknown): string | undefined {
  if (!Array.isArray(given) || given.length === 0 || given.length > MAX_ASSIGNEES)
    return `assignees are a list of one to ${String(MAX_ASSIGNEES)} key's texts`;
  const list = given as readonly unknown[];
  for (const assignee of list) {
    if (typeof assignee !== "string") return "an assignee is a key's text: a non-empty text";
    const rule = keyTextRuleOf(assignee);
    if (rule !== undefined)
      return `an assignee is a key's text (${rule}): ${KEY_TEXT_RULE_TEXT[rule]}`;
  }
  return new Set(list).size === list.length ? undefined : "an assignee is named once";
}

/** `assign` of the target: who the new pause is for. `undefined` and `[]` mean nobody in particular. */
export async function assignedBy(
  target: Pick<PauseTarget, "name" | "assign">,
  facts: OpeningFacts,
): Promise<readonly string[] | undefined> {
  if (target.assign === undefined) return undefined;
  let given: unknown;
  try {
    given = await target.assign({
      input: facts.input,
      ...(facts.toolCall === undefined ? {} : { toolCall: facts.toolCall }),
      trail: facts.trail,
    } as never);
  } catch (cause) {
    throw new PauseHookError(target.name, "its assign failed", { cause });
  }
  if (given === undefined || (Array.isArray(given) && given.length === 0)) return undefined;
  const problem = assigneesProblemOf(given);
  if (problem !== undefined)
    throw new PauseHookError(target.name, `its assign gave a bad list: ${problem}`);
  return given as readonly string[];
}

/**
 * `resolveTimeout` of the target: this pause's wait over the declared `timeout`; `undefined`: the
 * declared one. A value that is no duration of at least `seconds(1)` is `PauseError.InvalidTimeout`;
 * working time without the target's calendar, or a plain wait for a target that reminds in working
 * time, is `PauseError.WorkingCalendar`.
 */
export async function resolvedTimeoutBy(
  target: Pick<PauseTarget, "name" | "resolveTimeout" | "calendar" | "remindBefore">,
  facts: OpeningFacts & { readonly assignees?: readonly string[] | undefined },
): Promise<TimeSpan | undefined> {
  if (target.resolveTimeout === undefined) return undefined;
  let given: unknown;
  try {
    given = await target.resolveTimeout({
      input: facts.input,
      ...(facts.assignees === undefined ? {} : { assignees: facts.assignees }),
      ...(facts.toolCall === undefined ? {} : { toolCall: facts.toolCall }),
      trail: facts.trail,
    } as never);
  } catch (cause) {
    throw new PauseHookError(target.name, "its resolveTimeout failed", { cause });
  }
  if (given === undefined) return undefined;
  return checkedTimeout(target, given);
}

/** A resolved wait, checked against the target's calendar and reminder. */
export function checkedTimeout(
  target: Pick<PauseTarget, "name" | "calendar" | "remindBefore">,
  given: unknown,
): TimeSpan {
  if (!isPauseTimeout(given))
    throw new PauseError.InvalidTimeout({
      message: `pause target ${target.name}: its timeout is no duration of at least seconds(1)`,
    });
  if (isWorkingDuration(given) && target.calendar === undefined)
    throw new PauseError.WorkingCalendar({
      message: `pause target ${target.name}: its timeout counts working time but the target has no calendar`,
    });
  if (isWorkingDuration(target.remindBefore) && !isWorkingDuration(given))
    throw new PauseError.WorkingCalendar({
      message: `pause target ${target.name}: it reminds in working time, so its timeout must count working time`,
    });
  return given;
}
