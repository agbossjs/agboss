import { assertNotExternallyPaused } from "./external-pause.js";
import type { ExecutionLeases } from "./execution-leases.js";
import { answerValidatorOf, type AnswerChecks } from "../channels/decision.js";
import { checkedCallers } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { PauseStatus, type PauseRecord } from "../infrastructure/paused-execution.repository.js";
import {
  checkResume,
  type IncompatibleResumePolicy,
  type ResumeVersions,
} from "../run/resume-guard.js";
import type { ThreadAccess } from "../run/thread.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { AnyTool } from "../tools/index.js";
import type { AnyTenantApp, ResumeOptions, ResumeRequest } from "./types.js";
import { lazyLoad, type Clock } from "../infrastructure/clock.js";
import type { PauseAnswerLog } from "../infrastructure/pause-answer-log.js";
import {
  logPauseAnswer,
  PauseResolution,
  type PauseAnswer,
} from "../infrastructure/pause-record.js";
import type { ReplyAnswering, ReadReply } from "./reply-answer.js";
import type { AppDeps } from "./app-deps.js";
import { invalidDto } from "../dto/errors.js";
import { ExecutionOperation } from "../core/observability.js";
import type { ExecutionRequest } from "./run-events.js";
import type { TreeMoves } from "./tree-moves.js";
import { markAnswered, refusedAnswer } from "./paused-runs.js";
import { seenOf } from "../infrastructure/pause-seen.js";
import { noticesWritten, recipientsIn, type PauseNotices } from "../pause/index.js";
import { pauseTallyOf } from "../pause/pause-tally.js";
import { pauseClosed } from "./pause-closed.js";
import { actorOf, pauseOf } from "./pause-respondent.js";
import type { PauseActor } from "../channels/pause-contexts.js";
import { assertAnswerPermitted } from "./answer-permit.js";
import type { InlineFiles } from "../files/inline-offload.js";
import type { PermitAnswer } from "../channels/pause-contexts.js";
import type { AnsweredRootParts } from "./paused-runs.js";

/**
 * The first phase of `app.resume` (#267, Q58): the pause found by `(tenantId, pauseId)` anywhere in
 * its tree, who answers checked against its role's `respondent`, the decision validated (or a
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

/** The request's answer; a request with both, or an empty reply, is refused (`ValidationError.DtoInvalid`). */
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
  throw invalidDto({ dto: "ResumeRequest", issues: [{ path, reason }] });
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
  /** Checks the caller is the thread's owner (`ExecutionError.ThreadOwnerMismatch` otherwise). */
  readonly owned: (access: ThreadAccess) => Promise<void>;
  /** The tool a pause approves (its input checks `overrideInput`). */
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
  /** The pause's target's `permitAnswer` (#1307c); `undefined`: it has none. */
  readonly permits?: ((pause: PauseRecord) => PermitAnswer | undefined) | undefined;
  /** The inline cap (#1316): the answer's inline files over it are offloaded, or refused with no store. */
  readonly inline?: InlineFiles | undefined;
}

/** A recorded answer: the pause now `Resolved`, and its tree's run as it rests (if it rests). */
export interface RecordedAnswer {
  readonly pause: PauseRecord;
  /** The run as it rested; `undefined` while its first pass still moves the tree. */
  readonly run: AgentExecutionOutput | undefined;
}

export { actorOf, pauseOf } from "./pause-respondent.js";

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
  return recordedAnswer(parts, pause, request, await actorOf(parts, pause, call));
}

/** The answer a pause keeps: the decision, who gave it, a delegate channel's own mark (#1197), what it cost. */
const answerOf = (
  read: ReadReply,
  actor: PauseActor | undefined,
  source: AnswerSource,
): PauseAnswer => ({
  decision: read.decision,
  actor,
  // kept in the stored answer: a crash before the log write is repaired as `decided` too
  ...(source === PauseResolution.Decided ? { byDelegate: true as const } : {}),
  ...(read.usage.length === 0 ? {} : { usage: read.usage }),
});

/** Whose answer is recorded: a person's reply, or the decision a channel gave at once (#1193). */
export type AnswerSource = PauseResolution.Replied | PauseResolution.Decided;

/** The answer's inline files over the cap leave for the file store, owned by the pause's root run (#1316). */
const offloadedAnswer = (parts: AnswerParts, pause: PauseRecord, decision: unknown) =>
  parts.inline?.offload(decision, {
    tenantId: pause.tenantId,
    ownerId: pause.rootExecutionId,
  });

/**
 * The answer recorded on its pause by `actor` (already checked, or a channel's own name — #946):
 * what `recordAnswer` does once it knows who answers. A channel's decision (`source` `Decided`) is
 * logged `decided`, like the first send's decided-at-once outcome, and is not counted: the pause was
 * never asked of anyone — not opened, so not closed, and no wait for a human to time (#1193).
 */
export async function recordedAnswer(
  parts: AnswerParts,
  pause: PauseRecord,
  request: ResumeRequest,
  actor: PauseActor | undefined,
  source: AnswerSource = PauseResolution.Replied,
): Promise<RecordedAnswer> {
  const { tenantId } = pause;
  // refused at its deadline before the interpreter reads a reply or the tree is marked (#941, I2):
  // the store's compare-and-set is the final word
  const isDue = pause.expiresAt !== undefined && pause.expiresAt <= parts.clock.now().toISOString();
  if (pause.status !== PauseStatus.Pending || isDue)
    throw await pauseClosed(parts.pauses, pause, parts.clock.now());
  const { read, run } = await decisionOf(parts, pause, answerGivenBy(request));
  // a person's answer is permitted by its target before anything is marked or recorded (#1307c); a
  // channel's own decision is the application's and is not asked of the hook
  if (source === PauseResolution.Replied)
    await assertAnswerPermitted(parts, pause, actor, read.decision);
  await offloadedAnswer(parts, pause, read.decision);
  const answer = answerOf(read, actor, source);
  // the tree has work again before its answer is recorded (#850, paused-runs.ts)
  const isMarked = await markAnswered(parts, pause, run);
  const at = parts.clock.now();
  const resolved = await parts.pauses.resolveByTenantIdAndPauseId(
    tenantId,
    pause.pauseId,
    answer,
    at,
    recipientsIn(parts, pause),
    // the pause the permit was asked over: an in-place change since makes the permit stale
    seenOf(pause),
  );
  if (resolved === undefined) {
    throw await refusedAnswer(parts, pause, isMarked);
  }
  // its notices are written: looked for at once, before anything that may throw
  noticesWritten(parts);
  if (source === PauseResolution.Replied) pauseTallyOf(parts)?.closed(resolved);
  await logPauseAnswer(parts.answers, resolved, source);
  return { pause: resolved, run };
}

/** The tree a pause belongs to: its tenant and its root execution. */
const treeOfPause = (pause: PauseRecord) => ({
  tenantId: pause.tenantId,
  rootExecutionId: pause.rootExecutionId,
});

/** What `app.resume` of one workflow's app is built from. */
export interface ResumeParts extends AnswerParts {
  /** Observes a refused request (`onExecutionRejected`) and rethrows. */
  readonly admit: <T>(request: ExecutionRequest, checks: () => Promise<T>) => Promise<T>;
  /** Throws `ApplicationStoppingError` once `app.close()` began. */
  readonly accepting: () => void;
  /** The thread's owner: the resumed pass runs as it, whoever answered. */
  readonly ownerOf: (tenantId: string, threadId: string) => Promise<string | undefined>;
  readonly moves: Pick<TreeMoves, "resumed">;
  /** The tree's lease marks (#1341c): an answer on a tree frozen by `app.pause` is refused. */
  readonly leases?: Pick<ExecutionLeases, "pauseOf"> | undefined;
}

/**
 * `app.resume` in two phases (Q58): the answer recorded on its pause (`Pending → Resolved`, atomic,
 * a refusal observed — naming the thread once the pause is known), then the tree moved under its
 * lease, as the thread's owner (`executionContext.ownerId`).
 */
export const resumeOf =
  (parts: ResumeParts): AnyTenantApp["resume"] =>
  async (request, call = {}) => {
    const tenantId = call.tenantId ?? DEFAULT_TENANT_ID;
    const requested = { operation: ExecutionOperation.Resume, tenantId };
    const pause = await parts.admit(requested, () => {
      parts.accepting();
      checkedCallers("ResumeOptions", { ...call, tenantId });
      answerGivenBy(request);
      return pauseOf(parts.pauses, request, tenantId);
    });
    const answer = await parts.admit({ ...requested, threadId: pause.threadId }, async () => {
      await assertNotExternallyPaused(parts.leases, treeOfPause(pause));
      return recordAnswer(parts, pause, request, call);
    });
    const ownerId = await parts.ownerOf(tenantId, pause.threadId);
    return parts.moves.resumed(answer, { ...call, ownerId });
  };
