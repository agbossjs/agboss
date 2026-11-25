import type { FileDto } from "../../dto/standard/file.js";
import { NO_FILES, type SeenFile, type SourceFile } from "../../files/visit-files.js";
import type { ExecutionStateType } from "../../flow/runtime/state.js";
import { readerMemoryOf } from "../../flow/runtime/history.js";
import type { AgentAnswer } from "../../flow/runtime/answer-tools.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { AgentLoopStateType } from "./state.js";
import type { SensitiveValue } from "../../pii/policy-set.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import type {
  GuardrailDecisionRecord,
  JudgeVerdictRecord,
} from "../../flow/runtime/step-records.js";

/**
 * What of PII an agent's loop is handed: the execution's tokens and its sensitive values (#120),
 * and its own key of field tokens when the application sets none (#334).
 */
export interface LoopPii {
  readonly tokens: PiiTokenMap;
  readonly values: readonly SensitiveValue[];
  readonly key: string | null;
}

const NO_PII: LoopPii = { tokens: {}, values: [], key: null };

/** The files of an agent's input and the transcriptions the execution has (#899). */
export interface LoopFiles {
  readonly sources: readonly SourceFile[];
  readonly transcripts: Readonly<Record<string, string>>;
}

const NO_LOOP_FILES: LoopFiles = { sources: [], transcripts: {} };

/** What the agent remembers of the thread: its turns and its compaction's summaries (#120 PR 3). */
function memoryOf(
  state: ExecutionStateType,
  agent: string,
): Pick<AgentLoopStateType, "history" | "summaries"> {
  const memory = readerMemoryOf(state, agent);
  return { history: [...memory.history], summaries: [...memory.summaries] };
}

/** What the execution hands an agent's loop: its run, spend, memory and input message. */
export function loopInputOf(
  state: ExecutionStateType,
  agent: string,
  input: string,
  pii: LoopPii = NO_PII,
  files: LoopFiles = NO_LOOP_FILES,
): AgentLoopStateType {
  return {
    runId: state.runId,
    usage: state.usage,
    approvals: state.approvals,
    ...memoryOf(state, agent),
    inputMessage: input,
    inputFiles: [...files.sources],
    fileTranscripts: files.transcripts,
    fileTally: NO_FILES,
    seen: [],
    answerFiles: [],
    flowPath: [...state.path, agent],
    from: { usage: state.usage.length, approvals: state.approvals.length },
    messages: [],
    move: null,
    results: {},
    decisions: {},
    prepared: {},
    questionAnswers: {},
    callRecords: {},
    trajectory: [],
    judgeVerdicts: [],
    guardrailDecisions: [],
    modelCalls: 0,
    toolCalls: 0,
    reply: null,
    answer: null,
    answeredWith: [],
    retries: 0,
    invalidAnswers: 0,
    invalidArguments: 0,
    piiTokens: { ...state.piiTokens, ...pii.tokens },
    piiMasked: {},
    piiValues: pii.values,
    piiKey: pii.key,
  };
}

/** What a finished loop gives the execution: its answer (or text reply), spend and decisions. */
export interface LoopResult {
  readonly answer?: AgentAnswer;
  readonly reply: string;
  readonly usage: readonly UsageRecord[];
  readonly approvals: readonly ApprovalRecord[];
  /** Every PII token of the loop (merged by key into the execution's). */
  readonly piiTokens: PiiTokenMap;
  /** Its tool calls in call order (#395). */
  readonly toolCalls: readonly ToolCallRecord[];
  /** Its judges' verdicts and its input guardrails' decisions (#395 C3). */
  readonly judgeVerdicts: readonly JudgeVerdictRecord[];
  readonly guardrailDecisions: readonly GuardrailDecisionRecord[];
  /** The transcriptions it made (#899): the execution keeps them. */
  readonly fileTranscripts: Readonly<Record<string, string>>;
  /** The files of its answer (#899 §8): its output guardrails check them with it. */
  readonly answerFiles: readonly FileDto[];
  /** The source files it saw (#899 §8), numbered in the order it was shown them. */
  readonly seen: readonly SeenFile[];
}

export const loopResultOf = (after: AgentLoopStateType): LoopResult => ({
  ...(after.answer === null ? {} : { answer: after.answer }),
  reply: after.reply ?? "",
  usage: after.usage.slice(after.from.usage),
  approvals: after.approvals.slice(after.from.approvals),
  piiTokens: after.piiTokens,
  toolCalls: after.trajectory,
  judgeVerdicts: after.judgeVerdicts,
  guardrailDecisions: after.guardrailDecisions,
  fileTranscripts: after.fileTranscripts,
  answerFiles: after.answerFiles,
  seen: after.seen,
});
