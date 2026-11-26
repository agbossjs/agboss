import type { Class } from "../components/injection.js";
import type { PauseInputOf, PauseOutputOf } from "../flow/generated-types.js";
import type { Milliseconds, Timeout, WorkingDuration } from "../units/index.js";

/** The values a pause target's hooks and its channels read (#1307a). */

/** Who acts on a pause: an operator, an external system, in an organisation. */
export interface PauseActor {
  readonly id: string;
  readonly orgId?: string;
}

/** The tool call an approval pause waits on, as a channel and a hook read it. */
export interface PauseToolCallSummary {
  readonly callId: string;
  readonly tool: string;
  readonly summary?: string;
}

/** One step of a pause's chain of custody. */
export interface PauseTrailEntry {
  readonly action: "opened" | "reassigned" | "timeout-changed" | "escalated";
  readonly at: Date;
  readonly actor?: PauseActor;
  readonly target: string;
  readonly channel?: string;
  readonly assignees?: readonly string[];
  readonly expiresAt?: Date;
  readonly externalRef?: string;
  readonly reason?: string;
}

/** How far a pause may be extended, reassigned and prolonged in total. */
export interface PauseEscalationLimits {
  readonly maxExtensions?: number;
  readonly maxTotalTimeout?: WorkingDuration | Milliseconds;
  readonly maxReassignments?: number;
}

/** The decision on a gated tool call: what `app.resume` and a channel's `decided(…)` give. */
export interface ApprovalDecision<TInput = unknown> {
  readonly approved: boolean;
  readonly reason?: string;
  readonly overrideInput?: TInput;
}

/** What `assign` reads: the pause's input, its tool call and chain of custody. */
export interface AssignContext<TTarget> {
  readonly input: PauseInputOf<TTarget>;
  readonly toolCall?: PauseToolCallSummary;
  readonly trail: readonly PauseTrailEntry[];
}

/** What `resolveTimeout` reads. */
export interface TimeoutResolveContext<TTarget> {
  readonly input: PauseInputOf<TTarget>;
  readonly assignees?: readonly string[];
  readonly toolCall?: PauseToolCallSummary;
  readonly trail: readonly PauseTrailEntry[];
}

/** What `permitAnswer` reads: who answers, and with what. */
export interface AnswerPermissionContext<TTarget> {
  readonly actor?: PauseActor;
  readonly assignees?: readonly string[];
  readonly input: PauseInputOf<TTarget>;
  readonly output: PauseOutputOf<TTarget>;
  readonly toolCall?: PauseToolCallSummary;
  readonly externalRef?: string;
  readonly trail: readonly PauseTrailEntry[];
}

/** What `permitTimeoutChange` reads. */
export interface TimeoutPermissionContext<TTarget> {
  readonly actor?: PauseActor;
  readonly assignees?: readonly string[];
  readonly input: PauseInputOf<TTarget>;
  /** The timeout asked: counted from now; `Timeout.None` takes the deadline away. */
  readonly timeout: WorkingDuration | Milliseconds | Timeout;
  /** The deadline the pause has now; absent: none. */
  readonly currentExpiresAt?: Date;
  readonly reason?: string;
  readonly toolCall?: PauseToolCallSummary;
  readonly externalRef?: string;
  readonly trail: readonly PauseTrailEntry[];
}

/** What `permitReassign` reads. */
export interface ReassignPermissionContext<TTarget> {
  readonly actor?: PauseActor;
  readonly input: PauseInputOf<TTarget>;
  readonly assignees?: readonly string[];
  readonly target: string;
  readonly channel?: string;
  readonly toAssignees?: readonly string[];
  readonly toTarget?: Class;
  readonly toChannel?: Class;
  readonly timeout?: WorkingDuration | Milliseconds;
  readonly reason?: string;
  readonly toolCall?: PauseToolCallSummary;
  readonly externalRef?: string;
  readonly trail: readonly PauseTrailEntry[];
}

/** What `onExpired` reads: the pause that ran out its deadline, with its chain of custody. */
export interface ExpiredContext<TTarget> {
  /** Correlation, answers nothing: `pauseKeyOf(tenantId, pauseId)`. */
  readonly pauseKey: string;
  readonly input: PauseInputOf<TTarget>;
  readonly assignees?: readonly string[];
  /** When the pause was last asked. */
  readonly askedAt: Date;
  /** When it was first asked: where the chain's total wait counts from. */
  readonly firstAskedAt: Date;
  /** The deadline it ran out. */
  readonly expiresAt: Date;
  readonly toolCall?: PauseToolCallSummary;
  readonly externalRef?: string;
  readonly trail: readonly PauseTrailEntry[];
}

/** What `selectChannel` reads, when two or more channels serve one target. */
export interface ChannelSelectContext<TTarget> {
  readonly input: PauseInputOf<TTarget>;
  readonly assignees?: readonly string[];
  readonly expiresAt?: Date;
  readonly toolCall?: PauseToolCallSummary;
  readonly trail: readonly PauseTrailEntry[];
}

/** What the resume hands `permitAnswer`: its context, the typed `input` and `output` as the record keeps them. */
export type AnswerPermitCall = Omit<AnswerPermissionContext<never>, "input" | "output"> & {
  readonly input: unknown;
  readonly output: unknown;
};

/** What the timeout change hands `permitTimeoutChange`: the context, its `input` as the record keeps it. */
export type TimeoutPermitCall = Omit<TimeoutPermissionContext<never>, "input"> & {
  readonly input: unknown;
};

/** A target's `permitTimeoutChange`, as `app.setPauseTimeout` calls it (#1307): `true` permits; anything else refuses. */
export type PermitTimeoutChange = (ctx: TimeoutPermitCall) => Promise<unknown>;

/** What the reassignment hands `permitReassign`: the context, its `input` as the record keeps it. */
export type ReassignPermitCall = Omit<ReassignPermissionContext<never>, "input"> & {
  readonly input: unknown;
};

/** A target's `permitReassign`, as `app.reassignPause` calls it (#1307d): `true` permits; anything else refuses. */
export type PermitReassign = (ctx: ReassignPermitCall) => Promise<unknown>;

/**
 * A target's `permitAnswer`, as the resume calls it (#1307c): `true` lets the answer be recorded;
 * `false`, a throw and any other value refuse it.
 */
export type PermitAnswer = (ctx: AnswerPermitCall) => Promise<unknown>;
