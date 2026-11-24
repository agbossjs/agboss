import { lazyLoad } from "../../infrastructure/clock.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import { HumanMessage } from "@langchain/core/messages";
import { formatMemory } from "../../flow/runtime/history.js";
import { gatherKnowledge } from "../nodes/knowledge.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { AsyncNode } from "../types.js";
import type { AgentLoopDeps } from "./deps.js";
import { GuardrailSide } from "../../components/policy-decorators.js";
import type { GuardrailDecisionRecord } from "../../flow/runtime/step-records.js";
import { runGuardrails } from "../../guardrails/runtime.js";
import { maskedModelText } from "../../pii/model-boundary.js";
import { modelReadingMaskOf, withModelReading } from "../../pii/model-boundary.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import type { UsageRecord } from "../../finops/usage.js";
import { contentWithPieces } from "../../files/file-pieces.js";
import { fileMaskOf, type FileMask } from "../../files/file-mask.js";
import { NO_FILES, filePiecesOf, type FilePieces } from "../../files/visit-files.js";
import { PiiRefusedError } from "../../pii/errors.js";
import { AgentFailedError, StepFailedError } from "../errors.js";
import { LimitExceededError } from "../limits.js";
import { loopPoliciesOf } from "./model-pii.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";

const NO_PIECES: FilePieces = {
  pieces: [],
  viewed: [],
  tokens: {},
  maskedTexts: [],
  usage: [],
  digests: [],
  transcripts: {},
  tally: NO_FILES,
};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/**
 * For an agent visited again in the same execution: its own tool calls decided before, who decided
 * and what the tool returned — so it does not redo a write that is already done.
 */
export function formatDecisionsForAgent(
  approvals: readonly ApprovalRecord[],
  agent: string,
): string {
  const own = approvals.filter((record) => record.agent === agent);
  if (own.length === 0) return "";
  const lines = own.map((record) => {
    const call = `${record.tool} ${clip(JSON.stringify(record.args), 200)}`;
    return record.approved
      ? `- ${call}: approved by ${record.by} and DONE — result: ${clip(record.result ?? "", 300)}`
      : `- ${call}: rejected by ${record.by}, NOT done — ${record.result ?? ""}`;
  });
  return `Your tool calls decided in this execution (already settled — do not repeat them):\n${lines.join("\n")}`;
}

const joined = (parts: readonly string[]): string => parts.filter((p) => p !== "").join("\n\n");

/**
 * The agent's input guardrails (#120) on the input message as its model reads it — masked by its PII
 * policies (a block rule refuses here, as the model call would) — the masked form kept in the
 * loop's `piiMasked`, so the model's request is not searched twice.
 */
/** What the input guardrails add to the input node's update. */
interface GuardedInput {
  readonly usage: readonly UsageRecord[];
  readonly piiTokens: PiiTokenMap;
  readonly piiMasked: Readonly<Record<string, string>>;
  readonly decisions: readonly GuardrailDecisionRecord[];
}

const NOTHING_GUARDED: GuardedInput = { usage: [], piiTokens: {}, piiMasked: {}, decisions: [] };

async function guardedInput(
  deps: AgentLoopDeps,
  state: AgentLoopStateType,
  input: string,
  files: FilePieces,
): Promise<GuardedInput> {
  const guardrails = deps.guardrails ?? [];
  if (guardrails.length === 0) return NOTHING_GUARDED;
  const set = loopPoliciesOf(state, deps);
  const masked =
    set === undefined
      ? { text: input, tokens: {}, usage: [] }
      : await maskedModelText(set, input, state.piiTokens);
  // the files its model reads, in the views it reads them (#899 §8): what the guardrails check with the text
  const { guardedFilesOf } = await lazyLoad(import("../../files/guarded-files.js"));
  const seen = await guardedFilesOf(
    files.viewed,
    deps.agent.maxResultSize,
    fileMaskOf(set, state.piiTokens),
  );
  const checked = {
    text: masked.text,
    component: bareRecordOf(deps.agent.name, ComponentKind.Agent),
    side: GuardrailSide.Input,
    files: seen.files,
  };
  const passed = await runGuardrails(guardrails, checked, deps.observer);
  return {
    usage: [...masked.usage, ...seen.usage, ...passed.usage],
    decisions: passed.decisions,
    piiTokens: masked.tokens,
    piiMasked: set === undefined ? {} : { [set.maskCacheKeyOf(input, true)]: masked.text },
  };
}

/**
 * The files of the agent's input as pieces of its first message; none for an agent without files. Read
 * before its guardrails, which check what the model will read (#899 §3, §8); a block rule in a transcription
 * fails the execution as one in the text does (#899 §5).
 */
async function inputFilesOf(
  deps: AgentLoopDeps,
  state: AgentLoopStateType,
  mask: FileMask | undefined,
): Promise<FilePieces> {
  const runtime = deps.fileRuntime;
  if (runtime === undefined || state.inputFiles.length === 0) return NO_PIECES;
  try {
    return await filePiecesOf({
      runtime,
      files: state.inputFiles,
      tally: state.fileTally,
      cache: state.fileTranscripts,
      first: 1,
      of: state.inputFiles.length,
      mask,
      beforeModelCall: () => {
        deps.budgets.check(state.usage, state.flowPath, loopUsage(state));
      },
    });
  } catch (error) {
    if (
      error instanceof StepFailedError ||
      error instanceof LimitExceededError ||
      error instanceof PiiRefusedError
    )
      throw error;
    throw new AgentFailedError({ agent: deps.agent.name, usage: loopUsage(state), cause: error });
  }
}

/** The texts of the files' pieces already masked: the model boundary has nothing to search in them (#899 §7). */
const maskedPiecesOf = (files: FilePieces, mask: FileMask | undefined): Record<string, string> =>
  mask === undefined
    ? {}
    : Object.fromEntries(files.maskedTexts.map((text) => [mask.maskCacheKeyOf(text), text]));

/** What the input's files add to the loop: their tally, their transcriptions, the numbered files the model saw (#899 §8). */
const filesUpdateOf = (state: AgentLoopStateType, files: FilePieces): AgentLoopUpdate => ({
  fileTally: files.tally,
  fileTranscripts: files.transcripts,
  seen: state.inputFiles.flatMap((source, index) => {
    const digest = files.digests[index];
    return digest === undefined || digest === "" ? [] : [{ source, digest }];
  }),
});

/**
 * The agent's request after its static part (#270 Q51), once per call of the agent (a node of its
 * own, so a resume never retrieves, checks or pays for it again): the thread's memory as one message
 * (it changes rarely — a cache marker can follow it), then the input message with context-mode
 * knowledge and the decisions on its own calls in this execution — its input guardrails first.
 */
export function makeInputNode(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const { agent } = deps;
  return async (state, config) => {
    // a reranker's model reads the passages as this agent's model does (#708)
    const reading = modelReadingMaskOf(loopPoliciesOf(state, deps), state.piiTokens);
    const knowledge = await withModelReading(reading, () =>
      gatherKnowledge(
        agent.knowledge,
        state.inputMessage,
        config,
        deps.observer,
        agent.maxResultSize,
      ),
    );
    const memory = formatMemory(
      { summaries: state.summaries, history: state.history },
      { summaries: state.summaries.length, turns: state.history.length },
    );
    const input = joined([
      state.inputMessage,
      knowledge.block.trim(),
      formatDecisionsForAgent(state.approvals, agent.name),
    ]);
    const content = input === "" ? "(no input)" : input;
    // its files, read once and pinned for every call of the visit (#899 §3), then guarded with the text
    const mask = fileMaskOf(loopPoliciesOf(state, deps), state.piiTokens);
    const files = await inputFilesOf(deps, state, mask);
    const guarded = await guardedInput(deps, state, content, files);
    const messages = [
      ...(memory === "" ? [] : [new HumanMessage({ content: memory })]),
      new HumanMessage({ content: contentWithPieces(content, files.pieces) }),
    ];
    // counted at once (#338), in the ledger at once (#727)
    const spent = [...knowledge.records, ...guarded.usage, ...files.usage];
    const usage = [...deps.budgets.tally(spent, state.flowPath)];
    return {
      messages,
      usage,
      piiTokens: { ...guarded.piiTokens, ...files.tokens },
      piiMasked: { ...guarded.piiMasked, ...maskedPiecesOf(files, mask) },
      guardrailDecisions: [...guarded.decisions],
      ...filesUpdateOf(state, files),
    };
  };
}
