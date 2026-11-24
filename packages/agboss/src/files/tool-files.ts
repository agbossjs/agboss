import { lazyLoad } from "../infrastructure/clock.js";
import { bareRecordOf, ComponentKind } from "../flow/runtime/records.js";
import type { UsageRecord } from "../finops/usage.js";
import type { GuardrailDecisionRecord } from "../flow/runtime/step-records.js";
import { GuardrailSide } from "../components/policy-decorators.js";
import { checkGuardrails } from "../guardrails/runtime.js";
import { PiiRefusedError } from "../pii/errors.js";
import type { PiiTokenMap } from "../pii/tokens.js";
import { refusedCall, type ClosedResult } from "../graph/agent-loop/tool-pii.js";
import { fileMaskOf, type FileMask } from "./file-mask.js";
import type { StoredToolFiles, ToolTask } from "../graph/agent-loop/state.js";
import { dtoOf } from "../dto/redact.js";
import type { AgentLoopDeps } from "../graph/agent-loop/deps.js";
import type { AnyTool, ToolOutput } from "../tools/index.js";
import { filesOfValue } from "./input-files.js";
import {
  NO_FILES,
  filePiecesOf,
  type FileTally,
  type FilePieces,
  type SourceFile,
} from "./visit-files.js";
import { FileSource } from "./model-files.js";

/**
 * The files a tool's result holds, read for the model (#899 §2): the tool message stays text — the
 * descriptor — and a user message with the parts follows it. Read where the tool ran, once; the
 * visit's limits are checked where its calls are collected.
 */
export async function toolFilesOf(
  deps: AgentLoopDeps,
  tool: AnyTool,
  output: ToolOutput<unknown> | undefined,
  run: {
    readonly tally: FileTally;
    readonly cache: Readonly<Record<string, string>>;
    readonly mask?: FileMask | undefined;
    readonly beforeModelCall: () => void;
  },
): Promise<ToolFilesBuilt | undefined> {
  const runtime = deps.fileRuntime;
  if (runtime?.settings.sources.includes(FileSource.ToolResults) !== true) return undefined;
  const dto = dtoOf(tool.output);
  if (output?.kind !== "ok" || dto === undefined) return undefined;
  const found = filesOfValue(dto, output.value, tool.name);
  if (found.length === 0) return undefined;
  const files = found.map((file) => ({ ...file, producer: `tool ${tool.name}` }));
  // the files the visit holds count: its limits are checked before any read or transcription
  const built = await filePiecesOf({
    runtime,
    files,
    tally: run.tally,
    cache: run.cache,
    first: run.tally.count + 1,
    mask: run.mask,
    beforeModelCall: run.beforeModelCall,
  });
  return { ...built, sources: files, isGuarded: runtime.settings.guardToolResultFiles };
}

/** What a tool call's files add to its task: its stored files, the transcriptions made, the spend. */
export interface TaskFiles {
  readonly files?: StoredToolFiles;
  readonly transcripts?: Readonly<Record<string, string>>;
  /** The tokens the masked transcriptions introduced. */
  readonly tokens?: PiiTokenMap;
  readonly usage: readonly UsageRecord[];
  /** The input guardrails' decisions on the files (#899 §8). */
  readonly decisions?: readonly GuardrailDecisionRecord[];
  /**
   * Why the call is refused: a block rule in a file's text, or an input guardrail that blocked its
   * files. The model reads `content` as the tool's result and sees no file (#899 §5, §8).
   */
  readonly refused?: { readonly content: string; readonly error: Error };
}

/** What a file read of a tool's result gave, or why the call is refused. */
type ToolFilesRead =
  { readonly built: ToolFilesBuilt | undefined } | { readonly refusal: TaskFiles };

/** The read files, and whether the input guardrails check them (`guardToolResultFiles`). */
type ToolFilesBuilt = FilePieces & {
  readonly sources: readonly SourceFile[];
  readonly isGuarded: boolean;
};

/**
 * The call's files read before the task ends: the visit's budgets and file limits are checked before any
 * read or transcription, the transcriptions masked by the agent's policies — a block rule in one refuses the call.
 */
async function readToolFiles(
  deps: AgentLoopDeps,
  tool: AnyTool,
  task: ToolTask,
  output: ToolOutput<unknown> | undefined,
): Promise<ToolFilesRead> {
  const { budget, fileTally = NO_FILES } = task;
  const set = deps.pii?.withValues(task.piiValues ?? []).withFieldKey(task.piiKey);
  try {
    const built = await toolFilesOf(deps, tool, output, {
      tally: fileTally,
      cache: task.transcripts ?? {},
      mask: fileMaskOf(set, {}),
      beforeModelCall: () => {
        if (budget !== undefined) deps.budgets.check(budget.usage, budget.path, budget.loop);
      },
    });
    return { built };
  } catch (error) {
    if (!(error instanceof PiiRefusedError)) throw error;
    const refused = { content: refusedCall(error.refusal), error };
    return { refusal: { usage: error.usage, refused } };
  }
}

/**
 * The input guardrails on the files of a tool's result (`guardToolResultFiles`): their decisions, and a
 * refusal when one blocked; a guardrail that cannot decide fails the step.
 */
async function guardedToolFiles(
  deps: AgentLoopDeps,
  task: ToolTask,
  built: ToolFilesBuilt,
): Promise<Pick<TaskFiles, "usage" | "decisions" | "refused">> {
  const guardrails = deps.guardrails ?? [];
  if (!built.isGuarded || guardrails.length === 0) return { usage: built.usage };
  const set = deps.pii?.withValues(task.piiValues ?? []).withFieldKey(task.piiKey);
  const { guardedFilesOf } = await lazyLoad(import("./guarded-files.js"));
  const seen = await guardedFilesOf(built.viewed, deps.agent.maxResultSize, fileMaskOf(set, {}));
  const checked = {
    text: "",
    component: bareRecordOf(deps.agent.name, ComponentKind.Agent),
    side: GuardrailSide.Input,
    files: seen.files,
  };
  const guarded = await checkGuardrails(guardrails, checked, deps.observer);
  const usage = [...built.usage, ...seen.usage, ...guarded.usage];
  if (guarded.kind === "passed") return { usage, decisions: guarded.decisions };
  const refused = { content: refusedCall(guarded.error.refusal), error: guarded.error };
  return { usage, decisions: guarded.decisions, refused };
}

/**
 * The files of a call's result, read before the task ends (budgets, limits, masked transcriptions), then
 * the input guardrails on them: a block refuses the call, a guardrail that cannot decide fails the step.
 * The stored call holds references and digests, never bytes — they are read again, pinned, where the
 * calls are collected.
 */
export async function taskFilesOf(
  deps: AgentLoopDeps,
  tool: AnyTool,
  task: ToolTask,
  output: ToolOutput<unknown> | undefined,
): Promise<TaskFiles> {
  const read = await readToolFiles(deps, tool, task, output);
  if ("refusal" in read) return read.refusal;
  const { built } = read;
  if (built === undefined) return { usage: [] };
  const guarded = await guardedToolFiles(deps, task, built);
  const rest = { ...guarded, transcripts: built.transcripts, tokens: built.tokens };
  return guarded.refused === undefined
    ? finishedFiles(built, task.fileTally ?? NO_FILES, rest)
    : rest;
}

/** The task's files as stored: references and digests with their counts. */
function finishedFiles(
  built: FilePieces & { readonly sources: readonly SourceFile[] },
  before: FileTally,
  rest: Omit<TaskFiles, "files">,
): TaskFiles {
  const files = {
    sources: built.sources,
    digests: built.digests,
    count: built.tally.count - before.count,
    bytes: built.tally.bytes - before.bytes,
  };
  return { ...rest, files };
}

/** A guarded call: what it closed for the model and what the tool gave. */
interface FilableCall {
  readonly closed: ClosedResult;
  readonly output?: ToolOutput<unknown>;
}

/** The guarded call with the files of its result read (#899) and what they cost counted. */
export async function withFiles<TCall extends FilableCall>(
  deps: AgentLoopDeps,
  tool: AnyTool,
  task: ToolTask,
  guarded: TCall,
): Promise<TCall & Omit<TaskFiles, "refused">> {
  const { refused, ...read } = await taskFilesOf(deps, tool, task, guarded.output);
  const usage = deps.budgets.tally([...guarded.closed.usage, ...read.usage]);
  // a refused call's files never reach the model: it reads the refusal as the tool's result (#899 §5, §8)
  const closed =
    refused === undefined
      ? { ...guarded.closed, usage }
      : { ...guarded.closed, usage, content: refused.content, refusal: refused.error };
  return { ...guarded, closed, ...read };
}
