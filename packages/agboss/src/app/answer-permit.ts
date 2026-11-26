import { instantOfOptional } from "../infrastructure/pause-record-instants.js";
import type { AnswerPermitCall, PauseActor, PermitAnswer } from "../channels/pause-contexts.js";
import { trailOf } from "../flow/runtime/pause-chain.js";
import type { PauseTarget } from "../flow/runtime/pause.js";
import { pauseKeyOf, type PauseRecord } from "../infrastructure/pause-record.js";
import { PauseError } from "../core/error-families/pause-errors.js";
import type { AnswerParts } from "./resume.js";
import { ownDepsOf } from "./own-deps.js";
import { definedFields } from "../core/defined-fields.js";
import type { AppDeps } from "./app-deps.js";
import type { Class } from "../components/injection.js";
import type { Milliseconds, Timeout, WorkingDuration } from "../units/index.js";

/**
 * A target's `permitAnswer` (#1307c): called by the resume once the answer is read and validated and
 * before anything is recorded or moved. Fail closed: only `true` lets the answer through — `false`,
 * a throw, a rejection, an unresolvable target and any other value refuse it with `PauseError.PermissionDenied`, and the pause stays
 * as it was. The message names the pause, never the hook's text.
 */

/**
 * The pause's target as its workflow has it now. Fails closed: a workflow or target that cannot be
 * resolved (renamed, removed, a container error) throws — it is unknown whether it has a
 * `permitAnswer`, so the answer is refused, never let through unchecked.
 */
export function targetOfPause(deps: AppDeps, pause: PauseRecord): PauseTarget {
  const target = ownDepsOf(deps, pause.workflow).targetOf?.(pause.target);
  if (target === undefined) throw new TypeError(`no pause target ${pause.target}`);
  return target;
}

/** A pause's `permitAnswer` as its workflow has it now; `undefined`: none. */
export const permitsOf =
  (deps: AppDeps) =>
  (pause: PauseRecord): PermitAnswer | undefined =>
    targetOfPause(deps, pause).permitAnswer;

/** What `permitAnswer` reads for this pause, answered by `actor` with `output`. */
function permitCallOf(
  pause: PauseRecord,
  actor: PauseActor | undefined,
  output: unknown,
): AnswerPermitCall {
  return {
    ...(actor === undefined ? {} : { actor }),
    ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
    input: pause.input,
    output,
    ...(pause.toolCall === undefined ? {} : { toolCall: pause.toolCall }),
    ...(pause.externalRef === undefined ? {} : { externalRef: pause.externalRef }),
    trail: trailOf(pause),
  };
}

/**
 * Throws `PauseError.PermissionDenied` unless the pause's target permits: the hook asked is `hook`,
 * resolved by `permitOf` (a target that cannot be resolved refuses) and called with `ctx`. A target
 * without the hook permits.
 */
async function assertPermitted(
  pause: PauseRecord,
  what: "answer" | "reassignment" | "timeout change",
  hook: string,
  permitOf: () => PermitHook | undefined,
  ctx: () => unknown,
): Promise<void> {
  const key = pauseKeyOf(pause.tenantId, pause.pauseId);
  let permit: PermitHook | undefined;
  try {
    permit = permitOf();
  } catch (cause) {
    // the target cannot be resolved: whether it has the hook is unknown, so refuse
    throw new PauseError.PermissionDenied({
      message: `pause ${key}: its target cannot be resolved, the ${what} is refused`,
      cause,
    });
  }
  if (permit === undefined) return;
  let verdict: unknown;
  try {
    verdict = await (permit as (call: unknown) => Promise<unknown>)(ctx());
  } catch (cause) {
    throw new PauseError.PermissionDenied({
      message: `pause ${key}: its target's ${hook} failed, the ${what} is refused`,
      cause,
    });
  }
  if (verdict !== true)
    throw new PauseError.PermissionDenied({
      message: `pause ${key}: its target's ${hook} refused the ${what}`,
    });
}

/** A target's permission hook as the runtime calls it: only `true` permits. */
type PermitHook = (ctx: never) => Promise<unknown>;

/** Throws `PauseError.PermissionDenied` unless the pause's target permits this answer (or has no `permitAnswer`). */
export function assertAnswerPermitted(
  parts: Pick<AnswerParts, "permits">,
  pause: PauseRecord,
  actor: PauseActor | undefined,
  output: unknown,
): Promise<void> {
  return assertPermitted(
    pause,
    "answer",
    "permitAnswer",
    () => parts.permits?.(pause),
    () => permitCallOf(pause, actor, output),
  );
}

/** What a reassignment asks of `permitReassign`: where to, and why. */
export interface ReassignAsk {
  readonly actor?: PauseActor | undefined;
  readonly assignees?: readonly string[] | undefined;
  readonly reason?: string | undefined;
  /** The target and channel classes the call names, and the wait it asks for. */
  readonly toTarget?: Class | undefined;
  readonly toChannel?: Class | undefined;
  readonly timeout?: Milliseconds | WorkingDuration | undefined;
}

/** A pause's `permitReassign` as its workflow has it now; `undefined`: none. Fails closed like `permitsOf`. */
export const reassignPermitsOf =
  (deps: AppDeps) =>
  (pause: PauseRecord): PermitHook | undefined =>
    targetOfPause(deps, pause).permitReassign;

/**
 * Throws `PauseError.PermissionDenied` unless the pause's target permits this reassignment (or has no
 * `permitReassign`): fail closed, as `permitAnswer` — `false`, a throw, a rejection, an unresolvable
 * target and any other value refuse it, and the pause stays as it was.
 */
export function assertReassignPermitted(
  deps: AppDeps,
  pause: PauseRecord,
  ask: ReassignAsk,
  target?: PauseTarget,
): Promise<void> {
  if (target === undefined) assertNotAnswerGuarded(deps, pause, "permitReassign", "a reassignment");
  return assertPermitted(
    pause,
    "reassignment",
    "permitReassign",
    () => (target === undefined ? reassignPermitsOf(deps)(pause) : target.permitReassign),
    () => ({
      ...definedFields({
        actor: ask.actor,
        assignees: pause.assignees,
        channel: pause.channel,
        toAssignees: ask.assignees,
        toTarget: ask.toTarget,
        toChannel: ask.toChannel,
        timeout: ask.timeout,
        reason: ask.reason,
        toolCall: pause.toolCall,
        externalRef: pause.externalRef,
      }),
      input: pause.input,
      target: pause.target,
      trail: trailOf(pause),
    }),
  );
}

/**
 * A pause whose target guards its answers (`permitAnswer`) but not this operator act (`hook` absent) must
 * not let the act force what only an answer may: a shorter deadline makes `onExpired` decide, a
 * reassignment changes who answers (#1307, H2). Fail closed: `PauseError.PermissionDenied`; declare the
 * hook to allow it. A target that cannot be resolved is left to the hook's own check.
 */
export function assertNotAnswerGuarded(
  deps: AppDeps,
  pause: PauseRecord,
  hook: "permitTimeoutChange" | "permitReassign",
  what: string,
): void {
  let target: PauseTarget | undefined;
  try {
    target = targetOfPause(deps, pause);
  } catch {
    return;
  }
  if (target[hook] !== undefined || target.permitAnswer === undefined) return;
  throw new PauseError.PermissionDenied({
    message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: its target guards answers with permitAnswer but has no ${hook}, so ${what} is refused`,
  });
}

/** Whether the change is no longer deadline: an earlier one, one where there was none, or none where there was one (#1307, H2). */
const isShortening = (current: string | undefined, next: string | undefined): boolean =>
  next === undefined ? current !== undefined : current === undefined || next < current;

/** `assertNotAnswerGuarded` for a change of the deadline to `expiresAt` (absent: none): only a longer one passes without `permitTimeoutChange`. */
export function assertDeadlineNotGuarded(
  deps: AppDeps,
  pause: PauseRecord,
  expiresAt: string | undefined,
): void {
  if (!isShortening(pause.expiresAt, expiresAt)) return;
  assertNotAnswerGuarded(
    deps,
    pause,
    "permitTimeoutChange",
    "a change that is not a longer deadline",
  );
}

/** What a timeout change asks of `permitTimeoutChange`: how long, and why. */
export interface TimeoutChangeAsk {
  readonly actor?: PauseActor | undefined;
  readonly timeout: Milliseconds | WorkingDuration | Timeout;
  readonly reason?: string | undefined;
}

/**
 * Throws `PauseError.PermissionDenied` unless the pause's target permits this timeout change (or has
 * no `permitTimeoutChange`): fail closed, as `permitAnswer` — `false`, a throw, a rejection, an
 * unresolvable target and any other value refuse it, and the pause stays as it was.
 */
export function assertTimeoutChangePermitted(
  deps: AppDeps,
  pause: PauseRecord,
  ask: TimeoutChangeAsk,
): Promise<void> {
  return assertPermitted(
    pause,
    "timeout change",
    "permitTimeoutChange",
    () => targetOfPause(deps, pause).permitTimeoutChange,
    () => ({
      ...definedFields({
        actor: ask.actor,
        assignees: pause.assignees,
        currentExpiresAt: instantOfOptional(pause.expiresAt),
        reason: ask.reason,
        toolCall: pause.toolCall,
        externalRef: pause.externalRef,
      }),
      input: pause.input,
      timeout: ask.timeout,
      trail: trailOf(pause),
    }),
  );
}
