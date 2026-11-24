import { z } from "zod";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { ExecutionStatus } from "../app/types.js";
import { CompensationEntryStatus } from "../flow/compensation.js";
import type { CompensationEntry } from "../flow/compensation.js";
import type { HandledErrorRecord } from "../flow/runtime/child-records.js";
import { BranchStatus, BranchVerdict, type LaunchRecord } from "../flow/runtime/launch/records.js";
import type { ScopeRecords } from "../flow/runtime/records.js";
import type { Compacted } from "../run/compaction.js";
import type { AgentExecutionOutput, ExecutionData } from "../run/types.js";
import { PauseKind, questionAskOf } from "./pause-record.js";
import type { WaitingPause } from "../pause/types.js";
import {
  StoredCompensation,
  StoredCostReport,
  StoredEndedChild,
  StoredError,
  StoredExecutionStep,
  StoredOrigin,
  StoredOutdatedValue,
  StoredScopeValue,
  StoredStepRecord,
  StoredToolCall,
} from "./stored-record-parts.js";
import { StoredApprovalAsk } from "./stored-pause.js";
import { readStored, StoredComponent } from "./stored-step.js";

/**
 * A paused run as a store keeps it as JSON (`PausedExecution.run`), read whole and version tolerant
 * like the history record: only the 0.1.1 shape is read (no 0.1.0 name, no default for a missing
 * field: such a row is `StoredNamesUnreadableError`); a key the type does not know is dropped. `budgetUsd` may be `Infinity` (a run without a cost limit: the store's JSON tags it and
 * the decoded value comes here). Parsing a value reads it: the type is asserted nowhere.
 */

const text = z.string();
const count = z.number();

const StoredBranch = z.object({
  nodeId: text,
  copyNumber: count,
  itemIndex: count.optional(),
  status: z.enum(BranchStatus),
  error: StoredError.optional(),
  verdict: z.enum(BranchVerdict).optional(),
  acceptedSequence: count.optional(),
  rejectedBy: z.array(text).optional(),
});

const StoredLaunch: z.ZodType<LaunchRecord> = z.object({
  launch: text,
  items: count,
  taken: count,
  branches: z.array(StoredBranch),
  isQuorumReached: z.boolean().optional(),
  group: z.object({ targets: z.array(text), priority: count.optional() }).optional(),
});

const StoredHandledError: z.ZodType<HandledErrorRecord> = z.object({
  error: StoredError,
  at: StoredComponent,
  by: StoredComponent,
});

const StoredScope: z.ZodType<ScopeRecords> = z.record(text, StoredScopeValue);

const StoredCompensationEntry: z.ZodType<CompensationEntry> = z.object({
  key: text,
  executionId: text,
  sequence: count,
  action: text,
  compensated: StoredStepRecord,
  compensator: text,
  committer: text.optional(),
  launchId: text.optional(),
  input: StoredScope,
  status: z.enum(CompensationEntryStatus),
  undo: StoredCompensation.optional(),
});

const StoredData: z.ZodType<ExecutionData> = z.object({
  scope: StoredScope,
  outdatedValues: z.array(StoredOutdatedValue),
  lastError: StoredError.nullable(),
  launches: z.array(StoredLaunch).optional(),
  children: z.array(StoredEndedChild).optional(),
  handledErrors: z.array(StoredHandledError).optional(),
  compensations: z.array(StoredCompensationEntry).optional(),
  toolCalls: z.array(StoredToolCall).optional(),
  steps: z.array(StoredExecutionStep).optional(),
  origin: StoredOrigin.optional(),
});

const StoredCompacted: z.ZodType<Compacted> = z.object({
  memory: text,
  fromTurn: count,
  toTurn: count,
  summaries: count,
  summaryQueueLength: count.optional(),
});

/** A pause a run waits on. */
const StoredWaiting = z
  .object({
    pauseId: text,
    kind: z.enum(PauseKind),
    answerer: z.enum(PauseAnswerer),
    step: text,
    channel: text,
    childExecutionId: text.optional(),
    itemIndex: count.optional(),
    ask: z.record(text, z.unknown()),
  })
  .transform((stored, context): WaitingPause => {
    const { answerer, step } = stored;
    const approval = StoredApprovalAsk.safeParse(stored.ask);
    const refused = (path: string): typeof z.NEVER => {
      context.addIssue({
        code: "custom",
        path: [path],
        message: "missing or not what was written",
      });
      return z.NEVER;
    };
    const base = {
      pauseId: stored.pauseId,
      answerer,
      answeredBy: answerer,
      step,
      channel: stored.channel,
      childExecutionId: stored.childExecutionId,
      itemIndex: stored.itemIndex,
    };
    if (stored.kind === PauseKind.Question)
      return { ...base, kind: PauseKind.Question, ask: questionAskOf(stored.ask) };
    return approval.success
      ? { ...base, kind: PauseKind.Approval, ask: approval.data }
      : refused("ask");
  });

const StoredRun = z.object({
  status: z.literal(ExecutionStatus.Paused),
  start: text,
  startInput: z.unknown(),
  path: z.array(text),
  finish: text.optional(),
  output: z.unknown().optional(),
  // a run without a cost limit has Infinity (z.number() rejects it)
  budgetUsd: z.number().or(z.literal(Infinity)),
  cost: StoredCostReport,
  threadId: text,
  tenantId: text,
  turnId: text,
  data: StoredData,
  compacted: z.array(StoredCompacted).optional(),
  traceUrl: text.optional(),
  runId: text,
  pending: z.array(StoredWaiting),
  startedVersion: text.optional(),
});

/** A paused run from the JSON a store kept (decoded: its non-finite numbers restored), or unreadable. */
export const pausedRunOfValue = (value: unknown): AgentExecutionOutput =>
  readStored(StoredRun, value, "paused run", ["threadId", "runId"]);
