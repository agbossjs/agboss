import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildLoopGraph, type LoopGraph } from "./loop-graph.js";
import { scriptedModel, type ScriptedMove } from "./scripted-model.js";
import { codeJudge, defineTool } from "./tool.js";
import type {
  AgentJudges,
  CallJudge,
  CallVerdict,
  LoopAgent,
  LoopTool,
  ToolCallMove,
} from "./types.js";

const FilePath = z.object({ path: z.string() });
const FileWrite = z.object({ path: z.string(), content: z.string() });
const Pause = z.object({ ms: z.number() });

/** What the tools did, in order — the "outside world" a test asserts on. */
export type EffectLog = (effect: string) => void;

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });

/** read-file, write-file (needs approval), wait (a slow tool for parallel order checks). */
export const repoTools = (log: EffectLog, beforeWrite: readonly CallJudge[] = []): LoopTool[] => [
  defineTool({
    name: "read-file",
    input: FilePath,
    run: ({ path }) => {
      log(`read ${path}`);
      return Promise.resolve(path === "empty.txt" ? "" : `contents of ${path}`);
    },
  }),
  defineTool({
    name: "write-file",
    input: FileWrite,
    needsApproval: true,
    beforeCall: beforeWrite,
    run: ({ path, content }) => {
      log(`write ${path}=${content}`);
      return Promise.resolve(`wrote ${path}`);
    },
  }),
  defineTool({
    name: "wait",
    input: Pause,
    run: async ({ ms }, signal) => {
      await sleep(ms, signal);
      log(`waited ${String(ms)}`);
      return `waited ${String(ms)}`;
    },
  }),
];

const pathOf = (move: ToolCallMove): string => FilePath.safeParse(move.args).data?.path ?? "";

/** A tool-owned code judge: paths stay inside the repository. */
export const pathInsideRepository = (maxRevisions = 2): CallJudge =>
  codeJudge<ToolCallMove, CallVerdict>("path-inside-repository", maxRevisions, (move) =>
    pathOf(move).startsWith("/")
      ? { kind: "revise", remark: `${pathOf(move)} is outside the repository` }
      : { kind: "accept" },
  );

export const NO_JUDGES: AgentJudges = { beforeCall: [], afterCall: [], beforeAnswer: [] };

export interface AgentOptions {
  readonly moves: readonly ScriptedMove[];
  readonly log: EffectLog;
  readonly judges?: AgentJudges;
  readonly beforeWrite?: readonly CallJudge[];
  readonly maxRevisionsPerStep?: number;
  readonly onModelCall?: (moveIndex: number) => void;
}

export const coderAgent = (options: AgentOptions): LoopAgent => ({
  name: "coder",
  systemPrompt: "You change files in the repository.",
  model: scriptedModel(options.moves, options.onModelCall),
  tools: repoTools(options.log, options.beforeWrite),
  judges: options.judges ?? NO_JUDGES,
  maxRevisionsPerStep: options.maxRevisionsPerStep ?? 5,
});

/** A graph plus what it did: effects and model calls. */
export interface Harness {
  readonly graph: LoopGraph;
  readonly effects: string[];
  readonly modelCalls: number[];
  readonly checkpointer: BaseCheckpointSaver;
}

export function harness(
  options: Omit<AgentOptions, "log" | "onModelCall">,
  checkpointer: BaseCheckpointSaver = new MemorySaver(),
): Harness {
  const effects: string[] = [];
  const modelCalls: number[] = [];
  const agent = coderAgent({
    ...options,
    log: (effect) => effects.push(effect),
    onModelCall: (index) => modelCalls.push(index),
  });
  return { graph: buildLoopGraph(agent, checkpointer), effects, modelCalls, checkpointer };
}
