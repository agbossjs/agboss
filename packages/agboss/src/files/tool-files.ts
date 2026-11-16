import type { UsageRecord } from "../finops/usage.js";
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
    readonly beforeModelCall: () => void;
  },
): Promise<(FilePieces & { readonly sources: readonly SourceFile[] }) | undefined> {
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
    first: 1,
    beforeModelCall: run.beforeModelCall,
  });
  return { ...built, sources: files };
}

/** What a tool call's files add to its task: its stored files, the transcriptions made, the spend. */
export interface TaskFiles {
  readonly files?: StoredToolFiles;
  readonly transcripts?: Readonly<Record<string, string>>;
  readonly usage: readonly UsageRecord[];
}

/**
 * The files of a call's result, read before the task ends: the visit's budgets and file limits are
 * checked before any read or transcription, as the input node does. The stored call holds references
 * and digests, never bytes — they are read again, pinned, where the calls are collected.
 */
export async function taskFilesOf(
  deps: AgentLoopDeps,
  tool: AnyTool,
  task: ToolTask,
  output: ToolOutput<unknown> | undefined,
): Promise<TaskFiles> {
  const { budget, fileTally = NO_FILES } = task;
  const built = await toolFilesOf(deps, tool, output, {
    tally: fileTally,
    cache: task.transcripts ?? {},
    beforeModelCall: () => {
      if (budget !== undefined) deps.budgets.check(budget.usage, budget.path, budget.loop);
    },
  });
  if (built === undefined) return { usage: [] };
  const files = {
    sources: built.sources,
    digests: built.digests,
    count: built.tally.count - fileTally.count,
    bytes: built.tally.bytes - fileTally.bytes,
  };
  return { files, transcripts: built.transcripts, usage: built.usage };
}
