import type { FileDto } from "../../dto/standard/file.js";
import {
  NO_FILES,
  type FileTally,
  type SeenFile,
  type SourceFile,
} from "../../files/visit-files.js";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type { UsageRecord } from "../../finops/usage.js";
import type { AgentAnswer } from "../../flow/runtime/answer-tools.js";
import type { HistoryTurn } from "../../flow/runtime/history.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { SensitiveValue } from "../../pii/policy-set.js";
import { mergeMove } from "./move-entries.js";
import { mergeTokens, type PiiTokenMap } from "../../pii/tokens.js";
import type { LoopProgress } from "../../flow/context/frame.js";
import type { ToolCallStop } from "./tool-stops.js";
import type { ErrorRecord } from "../../core/error-record.js";
import type { ToolCallRemote } from "../../mesh/mesh-call.js";
import type { MeshLimitBody } from "../../mesh/mesh-wire.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import type {
  GuardrailDecisionRecord,
  JudgeVerdictRecord,
} from "../../flow/runtime/step-records.js";

const append = <TItem>(left: readonly TItem[], right: readonly TItem[]): TItem[] => [
  ...left,
  ...right,
];
const replace = <TValue>(_previous: TValue, next: TValue): TValue => next;
const add = (left: number, right: number): number => left + right;
const merge = <TValue>(
  left: Readonly<Record<string, TValue>>,
  right: Readonly<Record<string, TValue>>,
): Record<string, TValue> => ({ ...left, ...right });

/** A finished tool call, stored under its call id: after a resume or a restart it is never run again. */
export interface StoredToolCall {
  readonly callId: string;
  readonly tool: string;
  /** What the model reads back: the tool's result, or `Tool error: …`. */
  readonly content: string;
  /** A tool interceptor stopped the call (#384): the collect node fails the step with it. */
  readonly stop?: ToolCallStop;
  /**
   * The tool met a mesh limit (#398: a loop or the hops limit of a remote call), as plain data: the
   * collect node fails the step with that limit — the model never reads it.
   */
  readonly meshLimit?: MeshLimitBody;
  /**
   * The files of the result its model reads (#899): shown after the tool message; the collect node
   * checks the visit's limits on what they add.
   */
  readonly files?: StoredToolFiles;
}

/**
 * A tool result's files as the loop stores them (#899): references and digests, never bytes — what the
 * checkpoint and every record hold. The collect node reads them again, pinned to the digests.
 */
export interface StoredToolFiles {
  readonly sources: readonly SourceFile[];
  readonly digests: readonly string[];
  readonly count: number;
  readonly bytes: number;
}

/**
 * What a call became before its approval (#1295c): its arguments checked against the tool's input,
 * through the PII policies and the tool interceptors' `before` hooks — in that order, once. Kept by
 * call id, so a pause and a resume at its approval reuse it: nothing is checked, masked or asked of
 * an interceptor again.
 */
export type PreparedCall = PreparedCallEnd & {
  /** The arguments it was prepared on, as the tool is to get them: a rewrite of a hook included. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Whose arguments they are: the model's, or an approver's override (prepared once more, #1295c). */
  readonly from: PreparedFrom;
  /** The tool the call was for and the digest of the arguments the model gave: a reused call id never matches (#1295c). */
  readonly tool: string;
  readonly argsDigest: string;
  /** The remote execution an interceptor's hook reported while it ran (#398). */
  readonly remote?: ToolCallRemote;
};

export enum PreparedFrom {
  Model = "model",
  Approver = "approver",
}

/** How the preparing of a call ended. */
export type PreparedCallEnd =
  | {
      /** Passed every check: it waits for its approval (when its tool needs one), then it runs. */
      readonly kind: "ready";
      /** The arguments as an approver may see them: the PII policies' masks and `sensitive` fields applied. */
      readonly shown: Readonly<Record<string, unknown>>;
    }
  | {
      /** Its arguments are no input of the tool: never asked about, the tool's own error is the result. */
      readonly kind: "invalid";
    }
  | {
      /** A PII block rule's kind in its arguments: never asked about, never run. */
      readonly kind: "refused";
      readonly content: string;
      readonly refusal: ErrorRecord;
    }
  | {
      /** An interceptor answered the model (`reply`): never asked about, never run. */
      readonly kind: "replied";
      readonly message: string;
    }
  | {
      /** An interceptor stopped it (`block`, or a failure): never asked about, never run. */
      readonly kind: "stopped";
      readonly stop: ToolCallStop;
    };

/** An approver's decision on one call, before it ran. */
export interface CallDecision {
  readonly approved: boolean;
  readonly by: string;
  readonly reason?: string;
  readonly overrideInput?: Record<string, unknown>;
}

/**
 * The answer to one question call of the move (#712): the role's validated answer — the call's
 * result —, which role it answered (`maxVisits` counts them per visit) and who answered.
 */
export interface QuestionCallAnswer {
  readonly tool: string;
  /** The role's answer; absent when the call was not asked. */
  readonly answer?: unknown;
  /** Who answered; absent when the call was not asked. */
  readonly by?: string;
  /** Why the call's arguments are no valid ask: nothing was asked, the model reads it as an error. */
  readonly problem?: string;
}

/** How long the appended lists were when the flow handed the agent its work. */
export interface HandedOver {
  readonly usage: number;
  readonly approvals: number;
}

const NOTHING_HANDED_OVER: HandedOver = { usage: 0, approvals: 0 };

/**
 * The state of one agent's loop (its subgraph, #150): what the execution handed it — the run, its
 * spend so far, the thread's memory, its input message — plus the conversation with the
 * model, the move under way, finished calls and decisions by call id, the counters its limits check
 * and its answer. Checkpointed node by node — each tool call is its own task.
 */
export const AgentLoopState = Annotation.Root({
  runId: Annotation<string>({ reducer: replace, default: () => "" }),
  usage: Annotation<UsageRecord[]>({ reducer: append, default: () => [] }),
  approvals: Annotation<ApprovalRecord[]>({ reducer: append, default: () => [] }),
  history: Annotation<HistoryTurn[]>({ reducer: replace, default: () => [] }),
  summaries: Annotation<string[]>({ reducer: replace, default: () => [] }),
  /** The agent's input message (#270 Q51). */
  inputMessage: Annotation<string>({ reducer: replace, default: () => "" }),
  /** The files of its input its model reads (#899): read once by the input node. */
  inputFiles: Annotation<SourceFile[]>({ reducer: replace, default: () => [] }),
  /** The transcriptions made so far in the execution (#899 §7), by cache key; the loop adds its own. */
  fileTranscripts: Annotation<Readonly<Record<string, string>>>({
    reducer: merge,
    default: () => ({}),
  }),
  /**
   * The source files the model has seen in this visit, numbered from 1 in the order it was shown them
   * (#899 §8): the input's, then each tool call's as it is collected. An answer file is one of these by
   * number; the judges and the output guardrails read them again, pinned to their digests.
   */
  seen: Annotation<SeenFile[]>({ reducer: append, default: () => [] }),
  /** The files of the answer (#899 §8): what the output guardrails check with it; none while working. */
  answerFiles: Annotation<FileDto[]>({ reducer: replace, default: () => [] }),
  /** How many source files and bytes of them the conversation holds (#899): its limits are checked on it. */
  fileTally: Annotation<FileTally>({ reducer: replace, default: () => NO_FILES }),
  /** The flow nodes visited up to and including this agent (limit errors name it). */
  flowPath: Annotation<string[]>({ reducer: replace, default: () => [] }),
  /** Where this loop's additions start in the lists it was handed. */
  from: Annotation<HandedOver>({ reducer: replace, default: () => NOTHING_HANDED_OVER }),
  /** The conversation the model sees (the system prompt is added per call). */
  messages: Annotation<BaseMessage[]>({ reducer: append, default: () => [] }),
  /** The model's last move while its tool calls are judged, approved and run. */
  move: Annotation<AIMessage | null>({ reducer: replace, default: () => null }),
  results: Annotation<Record<string, StoredToolCall>, Record<string, StoredToolCall | undefined>>({
    reducer: mergeMove,
    default: () => ({}),
  }),
  decisions: Annotation<Record<string, CallDecision>, Record<string, CallDecision | undefined>>({
    reducer: mergeMove,
    default: () => ({}),
  }),
  /** The calls of the move as they were prepared by call id (#1295c): checked before any approval. */
  prepared: Annotation<Record<string, PreparedCall>, Record<string, PreparedCall | undefined>>({
    reducer: mergeMove,
    default: () => ({}),
  }),
  /** The answers to the visit's question calls by call id (#712): asked before the move's tools run. */
  questionAnswers: Annotation<
    Record<string, QuestionCallAnswer>,
    Record<string, QuestionCallAnswer | undefined>
  >({ reducer: mergeMove, default: () => ({}) }),
  /** Each ended call's record by its call id (#395): run, refused, declined or unparsable. */
  callRecords: Annotation<
    Record<string, ToolCallRecord>,
    Record<string, ToolCallRecord | undefined>
  >({ reducer: mergeMove, default: () => ({}) }),
  /** The visit's tool calls in call order (#395): a move's records, appended when it is collected. */
  trajectory: Annotation<ToolCallRecord[]>({ reducer: append, default: () => [] }),
  /** The judges' verdicts on the visit's replies (#395 C3), in the order they judged. */
  judgeVerdicts: Annotation<JudgeVerdictRecord[]>({ reducer: append, default: () => [] }),
  /** The input guardrails' decisions on what its model read (#395 C3). */
  guardrailDecisions: Annotation<GuardrailDecisionRecord[]>({
    reducer: append,
    default: () => [],
  }),
  modelCalls: Annotation<number>({ reducer: add, default: () => 0 }),
  toolCalls: Annotation<number>({ reducer: add, default: () => 0 }),
  /** The agent's reply as text (a text agent's answer; a structured answer's JSON); null while working. */
  reply: Annotation<string | null>({ reducer: replace, default: () => null }),
  /** A structured answer through an answer tool (S6); null for a text agent or while working. */
  answer: Annotation<AgentAnswer | null>({ reducer: replace, default: () => null }),
  /**
   * The answer's classes (#262 S125): the position in the agent's answer tools of the tool each
   * value was answered with — one for a single answer, one per item of a list; empty without one.
   */
  answeredWith: Annotation<number[]>({ reducer: replace, default: () => [] }),
  /** Judge rejections retried so far. */
  retries: Annotation<number>({ reducer: add, default: () => 0 }),
  /** Invalid answers so far (S9: 2 retries, then `AgentAnswerInvalidError`). */
  invalidAnswers: Annotation<number>({ reducer: add, default: () => 0 }),
  /** Tool calls whose arguments failed their tool's input check so far (#268 S93). */
  invalidArguments: Annotation<number>({ reducer: add, default: () => 0 }),
  /** The execution's PII tokens (#120 S38): handed in, every new one added by key. */
  piiTokens: Annotation<PiiTokenMap>({ reducer: mergeTokens, default: () => ({}) }),
  /** Texts this loop already masked for its model, by role and keyed digest (`PiiPolicySet.maskCacheKeyOf`, #120, #1269). */
  piiMasked: Annotation<Readonly<Record<string, string>>>({ reducer: merge, default: () => ({}) }),
  /** The execution's sensitive context values (#120 AC13), masked wherever they appear. */
  piiValues: Annotation<readonly SensitiveValue[]>({ reducer: replace, default: () => [] }),
  /** The execution's key of field tokens (#334); null = the policies' own (the application's). */
  piiKey: Annotation<string | null>({ reducer: replace, default: () => null }),
});

export type AgentLoopStateType = typeof AgentLoopState.State;
export type AgentLoopUpdate = typeof AgentLoopState.Update;

/** What this loop spent so far (not in the flow's state until the agent answers). */
export const loopUsage = (state: AgentLoopStateType): UsageRecord[] =>
  state.usage.slice(state.from.usage);

/** One tool call to run — the payload of its own task (`Send`). */
export interface ToolTask {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly runId: string;
  /** How the call was prepared (#1295c): its checked arguments, or why it does not run. */
  readonly prepared: PreparedCall;
  /** The execution's key of field tokens (#334); absent (a task of an old checkpoint) or null = the policies'. */
  readonly piiKey?: string | null;
  /**
   * The execution's sensitive values (#708): what a model called on the agent's behalf during the
   * call (a knowledge base's reranker) masks as the agent's own model does; absent in an old task.
   */
  readonly piiValues?: readonly SensitiveValue[];
  /**
   * The model call of the visit that made the move, from 1 (#1311): the `attempt` of its
   * `StreamEventKind.ToolCall` event's step; absent in a task from before it.
   */
  readonly turn?: number;
  /** The loop's progress when its move was made (#268 S93); absent in a task from before it. */
  readonly progress?: LoopProgress;
  /** What the loop's files and spend were when the move was made (#899): a call's files are checked on it. */
  readonly fileTally?: FileTally;
  /** The transcriptions the execution has made (#899 §7): a file seen again is not transcribed again. */
  readonly transcripts?: Readonly<Record<string, string>>;
  readonly budget?: {
    readonly usage: readonly UsageRecord[];
    readonly path: readonly string[];
    readonly loop: readonly UsageRecord[];
  };
  /** A question call's answer (#712): its result — the call asks, it runs nothing. */
  readonly answer?: unknown;
  /** Why a question call's arguments are no valid ask (#712): its result is that error. */
  readonly invalidAsk?: string;
}

/**
 * The loop's progress (#268 S93): its model calls so far — the iteration of the move under way —
 * plus `next` for the call about to be made, and its answers and tool arguments that failed
 * validation so far.
 */
export const loopProgressOf = (state: AgentLoopStateType, next = 0): LoopProgress => ({
  toolLoopIteration: state.modelCalls + next,
  validationAttempts: state.invalidAnswers + state.invalidArguments,
});

export const LOOP_NODE = {
  input: "input",
  model: "model",
  boundary: "boundary",
  prepare: "prepare",
  approval: "approval",
  tool: "tool",
  collect: "collect",
  reply: "agent-reply",
  answer: "agent-answer",
  judge: "judge",
} as const;
