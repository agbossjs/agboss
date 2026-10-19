import { randomBytes } from "node:crypto";
import type { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ToolCallApprovalAskDto } from "../dto/standard/framework.js";

/**
 * One pause of an execution tree as the application records it (#267 S35): made once per waiting
 * step — keyed by the step's idempotency key — before its channel is asked, so a retried `send`
 * and a re-entry after a sibling's answer find the same `pauseId`.
 */

/** Where a pause is (#265, Q58; #267 AC10). */
export enum PauseStatus {
  /** Waiting for its decision. */
  Pending = "pending",
  /** A resume recorded its decision; the tree's lease holder continues it. */
  Resolved = "resolved",
  /** Its step took the decision and went on: kept, so a late second answer gets `NotPausedError`. */
  Taken = "taken",
  /** Dropped: its branch was cancelled (a sibling failed under `FailFast`); it takes no answer. */
  Cancelled = "cancelled",
}

/** What a resume recorded on a pause: the validated decision and who gave it. */
export interface PauseResolution {
  readonly decision: unknown;
  /**
   * Who answered: the `answeredBy` of a `PauseAnswerer.Channel` pause's resume, the `ownerId` of a
   * `PauseAnswerer.ThreadOwner` one (`undefined` for a thread without an owner).
   */
  readonly answerer: string | undefined;
}

/** Where in the tree a pause waits: its execution, its step and the tree it belongs to. */
export interface PauseSite {
  readonly tenantId: string;
  readonly threadId: string;
  /** The root of its execution tree (the tree's lease and stores are keyed by it). */
  readonly rootExecutionId: string;
  /** The execution it waits in: the root's own id, or a child's (#263). */
  readonly executionId: string;
  /** The workflow of that execution (`@Workflow({ name })`). */
  readonly workflow: string;
  /** `step.idempotencyKey` of the waiting tool call: one pause per step key. */
  readonly stepKey: string;
  /** The step's node (`critic-agent#2` for a copy) and visit: a launch's branch is found by them. */
  readonly nodeId: string;
  readonly visitNumber: number;
  readonly itemIndex: number | undefined;
}

/** A pause: its id, where it waits, what it asks and where it is. */
export interface PauseRecord extends PauseSite {
  /** A random 128-bit token (hex), made once per pause: the right to answer it (AC3). */
  readonly pauseId: string;
  /** The agent whose tool call waits. */
  readonly agent: string;
  /** The channel asked: a role's name or a concrete `@Channel`'s. */
  readonly channel: string;
  /** Who may answer it (its channel role's `answeredBy`). */
  readonly answeredBy: PauseAnswerer;
  /** The question, `sensitive` fields masked. */
  readonly ask: ToolCallApprovalAskDto;
  readonly status: PauseStatus;
  /** Whether its channel's `send` returned (`awaitReply`): a re-entry does not ask again. */
  readonly isSent: boolean;
  /** The decision, once `Resolved`. */
  readonly resolution?: PauseResolution;
}

/** A pause's id: a cryptographically random 128-bit token, made once per pause (AC3). */
export const newPauseId = (): string => randomBytes(16).toString("hex");

/** The pause answered: `Resolved` with its decision. */
export const resolvedPause = (pause: PauseRecord, resolution: PauseResolution): PauseRecord => ({
  ...pause,
  status: PauseStatus.Resolved,
  resolution,
});
