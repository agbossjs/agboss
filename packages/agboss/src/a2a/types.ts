import { z } from "zod";
import type { ErrorDetails } from "../core/errors.js";

/**
 * How a remote run ended: the app's own outcomes (`Finished`, `Paused`, #269) and the ways a run
 * fails — stopped by a limit (`Limited`), by its signal or `cancel` (`Cancelled`), or any other
 * error (`Failed`).
 */
export enum A2AStatus {
  Finished = "finished",
  Paused = "paused",
  Failed = "failed",
  Limited = "limited",
  Cancelled = "cancelled",
}

/** `POST /execute`: the workflow start's input, and the thread to continue (omit for a new one). */
export interface A2AExecutionRequest<TInput = unknown> {
  readonly input: TInput;
  /** The caller's thread (#387: `threadId` on the wire too), in the caller's tenant. */
  readonly threadId?: string;
}

/**
 * What the caller gets back: the thread (absent when the run failed before it had one), the final
 * status and — when it reached a workflow finish — the finish's name and its output.
 */
export interface A2AExecutionResponse {
  readonly threadId?: string;
  readonly status: A2AStatus;
  readonly finish?: string;
  readonly output?: unknown;
  /** Why the run failed, was limited or cancelled. */
  readonly error?: string;
  /** The failure's stable code (an `AGBossError`'s `code`: `limit.toolCalls`… `limit.mesh-loop`). */
  readonly code?: string;
  /**
   * The facts of a mesh limit (#398: `limit.mesh-loop`, `limit.hops` — `entry`, `chain`, …), so the
   * calling `A2AClient` fails its step with the same error; no other failure's facts are sent.
   */
  readonly details?: ErrorDetails;
  /** A paused run: the ids of the pauses its caller may answer (`/resume` with one of them). */
  readonly pauseIds?: readonly string[];
}

/** Payload for answering one pause of a paused execution (#267: by its id, never by thread). */
export interface A2AResumeRequest<TDecision = unknown> {
  readonly pauseId: string;
  readonly decision: TDecision;
}

/**
 * Server-sent events of one run: `progress` while it runs (a text delta or a tool call), then one
 * `finish` with the final response — whatever the status.
 */
export type A2AEvent =
  | {
      readonly type: "progress";
      readonly payload: { readonly step: "text" | "tool"; readonly content: string };
    }
  | { readonly type: "finish"; readonly payload: { readonly result: A2AExecutionResponse } };

const statusSchema = z.enum(A2AStatus);

/** The wire shape of a response (what a client accepts from a remote agent). */
export const A2AResponseSchema = z.object({
  threadId: z.string().optional(),
  status: statusSchema,
  finish: z.string().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  pauseIds: z.array(z.string()).optional(),
});

/** The wire shape of an event. */
export const A2AEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    payload: z.object({ step: z.enum(["text", "tool"]), content: z.string() }),
  }),
  z.object({ type: z.literal("finish"), payload: z.object({ result: A2AResponseSchema }) }),
]);

/** The wire shape of a request (what the server accepts). */
export const A2ARequestSchema = z.object({
  input: z.unknown(),
  threadId: z.string().optional(),
});
