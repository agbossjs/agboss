import { PauseAnswererError, UnknownPauseError } from "../run/resume-agent.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { answerValidatorOf, type AnswerChecks } from "../channels/decision.js";
import { checkedCallers } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { PauseStatus, type PauseRecord } from "../infrastructure/paused-execution.repository.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import {
  checkResume,
  type IncompatibleResumePolicy,
  type ResumeVersions,
} from "../run/resume-guard.js";
import type { ThreadAccess } from "../run/thread.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { AnyTool } from "../tools/index.js";
import type { App, ResumeOptions, ResumeRequest } from "./types.js";
import { lazyLoad, type Clock } from "../infrastructure/clock.js";
import type { PauseAnswerLog } from "../infrastructure/pause-answer-log.js";
import {
  logPauseAnswer,
  pauseAnswererOf,
  PauseResolution,
} from "../infrastructure/pause-record.js";
import type { ReplyAnswering, ReadReply } from "./reply-answer.js";
import type { AppDeps } from "./app-deps.js";
import { DtoValidationError } from "../dto/errors.js";
import { ExecutionOperation } from "../core/observability.js";
import type { ExecutionRequest } from "./run-events.js";
import type { TreeMoves } from "./tree-moves.js";
import { markAnswered, refusedAfterMark } from "./paused-runs.js";
import { noticesWritten, recipientsIn, type PauseNotices } from "../pause/index.js";
import { pauseClosed } from "./pause-closed.js";
import type { AnsweredRootParts } from "./paused-runs.js";

/**
 * The first phase of `app.resume` (#267, Q58): the pause found by `(tenantId, pauseId)` anywhere in
 * its tree, who answers checked against its role's `answerer`, the decision validated (or a
 * free-text reply read by its role's interpreter, #267 PR 3), the versions checked — then
 * the resting root's record `running` again (#850), and `Pending → Resolved` with its decision,
 * atomically. Nothing moves the tree here; a refused resume leaves the pause as it was.
 */

/**
 * What a resume answers with (#267 PR 3): exactly one of a typed `decision` or a non-empty free-text
 * `reply` — by types, and checked here for an untyped (JS) caller, before the pause is looked up.
 */
type GivenAnswer =
  | { readonly kind: "decision"; readonly decision: unknown }
  | { readonly kind: "reply"; readonly reply: string };

/** The request's answer; a request with both, or an empty reply, is refused (`DtoValidationError`). */
function answerGivenBy(request: ResumeRequest): GivenAnswer {
  // read as an untyped caller may pass it: the types rule both forms together out already
  const reply: unknown = Reflect.get(request, "reply");
  const decision: unknown = Reflect.get(request, "decision");
  if (reply === undefined) return { kind: "decision", decision };
  if (decision !== undefined) return reject("(root)", "give a decision or a reply, not both");
  if (typeof reply !== "string" || reply.trim() === "")
    return reject(".reply", "a reply is a non-empty text");
  return { kind: "reply", reply };
}

function reject(path: string, reason: string): never {
  throw new DtoValidationError({ dto: "ResumeRequest", issues: [{ path, reason }] });
}

/**
 * Reading free-text replies, loaded with the first one (#205: the root import stays lean, like
 * tracing and MCP): the reader is built once, on the app's run deps.
 */
export function lazyReplyAnswering(deps: AppDeps): ReplyAnswering {
  let loaded: Promise<ReplyAnswering> | undefined;
  return async (...call) => {
    loaded ??= lazyLoad(import("./reply-answer.js")).then((found) => found.replyAnsweringFor(deps));
    return (await loaded)(...call);
  };
}

/** What recording an answer needs from the workflow's app. */
export interface AnswerParts extends AnsweredRootParts {
  /** Checks the caller is the thread's owner (`ThreadOwnerError` otherwise). */
  readonly owned: (access: ThreadAccess) => Promise<void>;
  /** The tool a pause approves (its input checks `overrideArguments`). */
  readonly tools: (name: string) => AnyTool;
  /**
   * The answer DTO of a question role's step (#659), by the workflow it waits in and its node: what
   * a question's decision is validated as; `undefined` when the tree has none.
   */
  readonly questions?: AnswerChecks["questions"];
  readonly current: ResumeVersions;
  readonly policy: IncompatibleResumePolicy | undefined;
  /** Reads a free-text reply through the pause's role's interpreter (#267 PR 3). */
  readonly replies: ReplyAnswering;
  /** The application's clock: when the pause was resolved. */
  readonly clock: Clock;
  /** The execution records: who answered is written there (#267 S107). */
  readonly answers: PauseAnswerLog;
  /** Who hears of the answer (#940): its notices are written with it. */
  readonly notices?: PauseNotices | undefined;
}

/** A recorded answer: the pause now `Resolved`, and its tree's run as it rests (if it rests). */
export interface RecordedAnswer {
  readonly pause: PauseRecord;
  /** The run as it rested; `undefined` while its first pass still moves the tree. */
  readonly run: AgentExecutionOutput | undefined;
}

/** Who answers, as the pause's role says — checked; `undefined` for an unowned thread's owner. */
async function answeredByOf(
  parts: AnswerParts,
  pause: PauseRecord,
  call: ResumeOptions,
): Promise<string | undefined> {
  const { ownerId, answeredBy } = call;
  if (pauseAnswererOf(pause) === PauseAnswerer.ThreadOwner) {
    if (answeredBy !== undefined) {
      throw new PauseAnswererError({
        message: `pause ${pause.pauseId} is answered by the thread's owner (${pause.channel}): pass ownerId, not answeredBy`,
      });
    }
    await parts.owned({ tenantId: pause.tenantId, threadId: pause.threadId, ownerId });
    return ownerId;
  }
  if (ownerId !== undefined) {
    throw new PauseAnswererError({
      message: `pause ${pause.pauseId} is answered through its channel (${pause.channel}): pass answeredBy, not ownerId`,
    });
  }
  if (typeof answeredBy !== "string" || answeredBy.trim() === "") {
    throw new PauseAnswererError({
      message: `pause ${pause.pauseId} is answered through its channel (${pause.channel}): answeredBy must name who answered`,
    });
  }
  return answeredBy;
}

/** The tenant's pause a resume answers; `UnknownPauseError` when the tenant has none of that id. */
export async function pauseOf(
  pauses: PausedExecutionRepository,
  request: ResumeRequest,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<PauseRecord> {
  const pause = await pauses.findByTenantIdAndPauseId(tenantId, request.pauseId);
  if (pause === undefined) {
    throw new UnknownPauseError({ message: `tenant ${tenantId} has no pause ${request.pauseId}` });
  }
  return pause;
}

/** The tree's run as it rests, its versions checked against the app's; `undefined` while it moves. */
async function restingRunOf(
  parts: AnswerParts,
  pause: PauseRecord,
): Promise<AgentExecutionOutput | undefined> {
  const stored = await parts.paused.find({ tenantId: pause.tenantId, threadId: pause.threadId });
  const run = stored?.run.runId === pause.rootExecutionId ? stored.run : undefined;
  if (stored !== undefined && run !== undefined) {
    const { workflowVersion, configHash } = stored;
    const paused = { workflowVersion, configHash };
    const check = {
      threadId: pause.threadId,
      executionId: run.runId,
      paused,
      current: parts.current,
    };
    checkResume(check, parts.policy);
  }
  return run;
}

/**
 * The decision the answer gives, validated: a typed decision as it is (validated before the
 * versions, as always); a reply read once the versions passed — no model is called for a resume
 * that is refused anyway.
 */
async function decisionOf(
  parts: AnswerParts,
  pause: PauseRecord,
  given: GivenAnswer,
): Promise<{ readonly read: ReadReply; readonly run: AgentExecutionOutput | undefined }> {
  const validate = answerValidatorOf(pause, parts);
  if (given.kind === "decision") {
    const decision = validate(given.decision);
    return { read: { decision, usage: [] }, run: await restingRunOf(parts, pause) };
  }
  const run = await restingRunOf(parts, pause);
  return { read: await parts.replies(pause, given.reply, run, validate), run };
}

/** The first phase of a resume: the answer recorded on its pause; the tree is not moved yet. */
export async function recordAnswer(
  parts: AnswerParts,
  pause: PauseRecord,
  request: ResumeRequest,
  call: ResumeOptions,
): Promise<RecordedAnswer> {
  const { tenantId } = pause;
  const answeredBy = await answeredByOf(parts, pause, call);
  // refused at its deadline before the interpreter reads a reply or the tree is marked (#941, I2):
  // the store's compare-and-set is the final word
  const isDue = pause.expiresAt !== undefined && pause.expiresAt <= parts.clock.now().toISOString();
  if (pause.status !== PauseStatus.Pending || isDue)
    throw await pauseClosed(parts.pauses, pause, parts.clock.now());
  const { read, run } = await decisionOf(parts, pause, answerGivenBy(request));
  const answer = {
    decision: read.decision,
    answeredBy,
    ...(read.usage.length === 0 ? {} : { usage: read.usage }),
  };
  // the tree has work again before its answer is recorded (#850, paused-runs.ts)
  const isMarked = await markAnswered(parts, pause, run);
  const at = parts.clock.now();
  const resolved = await parts.pauses.resolveByTenantIdAndPauseId(
    tenantId,
    pause.pauseId,
    answer,
    at,
    recipientsIn(parts, pause),
  );
  if (resolved === undefined) {
    throw await (isMarked
      ? refusedAfterMark(parts, pause)
      : pauseClosed(parts.pauses, pause, parts.clock.now()));
  }
  // its notices are written: looked for at once, before anything that may throw
  noticesWritten(parts);
  await logPauseAnswer(parts.answers, resolved, PauseResolution.Replied);
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
      checkedCallers("ResumeOptions", { ...call, tenantId });
      answerGivenBy(request);
      return pauseOf(parts.pauses, request, tenantId);
    });
    const answer = await parts.admit({ ...requested, threadId: pause.threadId }, () =>
      recordAnswer(parts, pause, request, call),
    );
    const ownerId = await parts.ownerOf(tenantId, pause.threadId);
    return parts.moves.resumed(answer, { ...call, ownerId });
  };
