import { AGBossError } from "../core/errors.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { validDecisionOf } from "../channels/decision.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../infrastructure/paused-execution.repository.js";
import { NotPausedError } from "../run/resume-agent.js";
import {
  checkResume,
  type IncompatibleResumePolicy,
  type ResumeVersions,
} from "../run/resume-guard.js";
import type { ThreadAccess } from "../run/thread.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { AnyTool } from "../tools/index.js";
import type { PausedRunBook } from "./paused-runs.js";
import type { App, ResumeOptions, ResumeRequest } from "./types.js";
import { ExecutionOperation } from "../core/observability.js";
import type { ExecutionRequest } from "./run-events.js";
import type { TreeMoves } from "./tree-moves.js";

/**
 * The first phase of `app.resume` (#267, Q58): the pause found by `(tenantId, pauseId)` anywhere in
 * its tree, who answers checked against its role's `answeredBy`, the decision validated, the
 * versions checked — then `Pending → Resolved` with its decision, atomically. Nothing moves the
 * tree here; a refused resume leaves the pause as it was.
 */

/** A pause id the tenant does not have — unknown, or another tenant's: the same error, no hint. */
export class UnknownPauseError extends AGBossError {
  static override readonly code: string = "pause.unknown";
  override name = "UnknownPauseError";
}

/**
 * A pause answered with the wrong credential (#267 AC4): a `ThreadOwner` pause with `answeredBy`, a
 * `Channel` pause with `ownerId`, or a `Channel` pause without a non-empty `answeredBy`.
 */
export class PauseAnswererError extends AGBossError {
  static override readonly code: string = "pause.wrong-answerer";
  override name = "PauseAnswererError";
}

/** What recording an answer needs from the workflow's app. */
export interface AnswerParts {
  readonly pauses: PausedExecutionRepository;
  readonly paused: PausedRunBook;
  /** Checks the caller is the thread's owner (`ThreadOwnerError` otherwise). */
  readonly owned: (access: ThreadAccess) => Promise<void>;
  /** The tool a pause approves (its input checks `overrideArguments`). */
  readonly tools: (name: string) => AnyTool;
  readonly current: ResumeVersions;
  readonly policy: IncompatibleResumePolicy | undefined;
}

/** A recorded answer: the pause now `Resolved`, and its tree's run as it rests (if it rests). */
export interface RecordedAnswer {
  readonly pause: PauseRecord;
  /** The run as it rested; `undefined` while its first pass still moves the tree. */
  readonly run: AgentExecutionOutput | undefined;
}

/** Who answers, as the pause's role says — checked; `undefined` for an unowned thread's owner. */
async function answererOf(
  parts: AnswerParts,
  pause: PauseRecord,
  call: ResumeOptions,
): Promise<string | undefined> {
  const { ownerId, answeredBy } = call;
  if (pause.answeredBy === PauseAnswerer.ThreadOwner) {
    if (answeredBy !== undefined) {
      throw new PauseAnswererError(
        `pause ${pause.pauseId} is answered by the thread's owner (${pause.channel}): pass ownerId, not answeredBy`,
      );
    }
    await parts.owned({ tenantId: pause.tenantId, threadId: pause.threadId, ownerId });
    return ownerId;
  }
  if (ownerId !== undefined) {
    throw new PauseAnswererError(
      `pause ${pause.pauseId} is answered through its channel (${pause.channel}): pass answeredBy, not ownerId`,
    );
  }
  if (typeof answeredBy !== "string" || answeredBy.trim() === "") {
    throw new PauseAnswererError(
      `pause ${pause.pauseId} is answered through its channel (${pause.channel}): answeredBy must name who answered`,
    );
  }
  return answeredBy;
}

const notPaused = (pauseId: string): NotPausedError =>
  new NotPausedError(`pause ${pauseId} is not waiting for an answer`);

/** The tenant's pause a resume answers; `UnknownPauseError` when the tenant has none of that id. */
export async function pauseOf(
  pauses: PausedExecutionRepository,
  request: ResumeRequest,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<PauseRecord> {
  const pause = await pauses.findByTenantIdAndPauseId(tenantId, request.pauseId);
  if (pause === undefined) {
    throw new UnknownPauseError(`tenant ${tenantId} has no pause ${request.pauseId}`);
  }
  return pause;
}

/** The first phase of a resume: the answer recorded on its pause; the tree is not moved yet. */
export async function recordAnswer(
  parts: AnswerParts,
  pause: PauseRecord,
  request: ResumeRequest,
  call: ResumeOptions,
): Promise<RecordedAnswer> {
  const { tenantId } = pause;
  const answerer = await answererOf(parts, pause, call);
  if (pause.status !== PauseStatus.Pending) throw notPaused(pause.pauseId);
  const decision = validDecisionOf(request.decision, parts.tools(pause.ask.tool));
  const stored = await parts.paused.find({ tenantId, threadId: pause.threadId });
  const run = stored?.run.runId === pause.rootExecutionId ? stored.run : undefined;
  if (stored !== undefined && run !== undefined) {
    const { workflowVersion, configHash } = stored;
    const paused = { workflowVersion, configHash };
    const check = { thread: pause.threadId, runId: run.runId, paused, current: parts.current };
    checkResume(check, parts.policy);
  }
  const resolution = { decision, answerer };
  const resolved = await parts.pauses.resolveByTenantIdAndPauseId(
    tenantId,
    pause.pauseId,
    resolution,
  );
  if (resolved === undefined) throw notPaused(pause.pauseId);
  return { pause: resolved, run };
}

/** What `app.resume` of one workflow's app is built from. */
export interface ResumeParts extends AnswerParts {
  /** Observes a refused request (`onExecutionRejected`) and rethrows. */
  readonly admit: <T>(request: ExecutionRequest, checks: () => Promise<T>) => Promise<T>;
  /** Throws `ApplicationStoppingError` once `app.close()` began. */
  readonly accepting: () => void;
  /** The thread's owner: the resumed pass runs as it, whoever answered. */
  readonly ownerOf: (tenantId: string, threadId: string) => Promise<string | undefined>;
  readonly moves: Pick<TreeMoves, "resumed">;
}

/**
 * `app.resume` in two phases (Q58): the answer recorded on its pause (`Pending → Resolved`, atomic,
 * a refusal observed — naming the thread once the pause is known), then the tree moved under its
 * lease, as the thread's owner (`executionContext.ownerId`).
 */
export const resumeOf =
  (parts: ResumeParts): App["resume"] =>
  async (request, call = {}) => {
    const tenantId = call.tenantId ?? DEFAULT_TENANT_ID;
    const requested = { operation: ExecutionOperation.Resume, tenantId };
    const pause = await parts.admit(requested, () => {
      parts.accepting();
      return pauseOf(parts.pauses, request, tenantId);
    });
    const answer = await parts.admit({ ...requested, threadId: pause.threadId }, () =>
      recordAnswer(parts, pause, request, call),
    );
    const ownerId = await parts.ownerOf(tenantId, pause.threadId);
    return parts.moves.resumed(answer, { ...call, ownerId });
  };
