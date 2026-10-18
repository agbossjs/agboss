import type { Class } from "../../components/injection.js";
import type { ComponentRecord } from "../runtime/records.js";
import type { TenantContext } from "./tenant-context.js";

/**
 * The execution context (#280, #261): the one context of an execution, injected through the
 * constructor (`deps: [ExecutionContext]`, `constructor(private readonly executionContext:
 * ExecutionContext)`). It holds data about the current execution and its current step only — no
 * container, no I/O — and is read-only. Wiki → Components.
 */

/** A `@Workflow` class (`executionOf(W)`, `WorkflowDescriptor.type`). */
export type WorkflowClass = Class;

/** A component in the live context: its class and its `name` (the stable key, #272). */
export interface ComponentDescriptor extends ComponentRecord {
  readonly type: Class;
}

/** The workflow an execution runs, as plain data (observer events, records; #261 Q42). */
export interface WorkflowRecord {
  readonly name: string;
  readonly version: string;
  /** The version the execution started on (differs from `version` after a deploy and a resume). */
  readonly startedVersion: string;
}

/** The workflow an execution runs: its class, `name`, the version now and the one it started on. */
export interface WorkflowDescriptor extends WorkflowRecord {
  readonly type: WorkflowClass;
}

/** One visit of a node as plain data (`event.step`): the serialized `StepDescriptor` (#261 Q42). */
export interface StepRecord {
  readonly component: ComponentRecord;
  /** The node's id in `result.path`, traces and the key: its `name` (`critic-agent#2` for a copy). */
  readonly nodeId: string;
  /** The pass through this node in the execution, from 1 — the counter `maxVisits` checks. */
  readonly visitNumber: number;
  /** `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]` — the same on a retry. */
  readonly idempotencyKey: string;
  /** The model's tool-call id while a tool call runs; `undefined` everywhere else. */
  readonly callId: string | undefined;
  /** The item's index in a per-item launch (#273), from 0; `undefined` otherwise. */
  readonly itemIndex: number | undefined;
  /** Which copy of a repeated agent this is (#273), from 1; `1` when the agent is not repeated. */
  readonly copyNumber: number;
}

/** One visit of a node: different in each parallel branch and in each tool call. */
export interface StepDescriptor extends StepRecord {
  readonly component: ComponentDescriptor;
}

/**
 * The current execution: the type and the DI token. The injected object is not a snapshot — every
 * read gives the current execution and step; a read outside an execution, or after the step it
 * belongs to ended, throws `ExecutionContextUnavailableError`.
 */
export abstract class ExecutionContext {
  // `declare`: the framework sets them on its own instance; a subclass adds its fields only
  /** Unique per execution; the same after a resume. */
  declare readonly executionId: string;
  /** The conversation the execution belongs to (`ExecutionOutput.thread`). */
  declare readonly threadId: string;
  /** Who the thread belongs to (`execute(…, { ownerId })`); `undefined` for a thread without one. */
  declare readonly ownerId: string | undefined;
  /**
   * The organization the execution works for (#261): the execution's one `TenantContext` — the
   * project's subclass when the application declares one — and through it `tenant.application`.
   */
  declare readonly tenant: TenantContext;
  /** Aborted by `app.cancel(threadId)` or by the caller's own `signal`. */
  declare readonly signal: AbortSignal;
  declare readonly workflow: WorkflowDescriptor;
  declare readonly step: StepDescriptor;
  /** The index of a child launched per item (#263); `undefined` for a root or a single child. */
  declare readonly itemIndex: number | undefined;
  /** The parent execution, `undefined` at the root (one level until #263). */
  declare readonly parent: this | undefined;
  /** The root execution; `root === this` at the root. */
  declare readonly root: this;
  /** The level in the execution tree, from 1 at the root. */
  declare readonly depth: number;
  /** The nearest execution of `workflow` in the chain, this one included; `undefined` when none. */
  declare readonly executionOf: (workflow: WorkflowClass) => this | undefined;
}
