import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { ApprovalAnswerSchema } from "./act-nodes.js";
import {
  customEvents,
  isTerminal,
  QuestionSchema,
  taskEvents,
  tokenEvents,
  type RunEvent,
  type RunResult,
} from "./events.js";
import type { LoopGraph } from "./loop-graph.js";
import type { LoopStateType } from "./state.js";
import type { ApprovalAnswer } from "./types.js";

export interface RunOptions {
  readonly thread: string;
  readonly signal?: AbortSignal;
}

type LoopInput = Parameters<LoopGraph["stream"]>[0];

export class ResumeError extends Error {
  override name = "ResumeError";
  constructor(
    readonly code: "resume.not-paused" | "resume.invalid-answer",
    message: string,
  ) {
    super(message);
  }
}

const config = (thread: string) => ({ configurable: { thread_id: thread } });

/** The checkpointed state of a thread. LangGraph boundary: snapshot values are untyped. */
export async function loopStateOf(graph: LoopGraph, thread: string): Promise<LoopStateType> {
  const snapshot = await graph.getState(config(thread));
  return snapshot.values as LoopStateType;
}

/** Is the thread waiting for an answer (an interrupt pending)? */
export async function isPaused(graph: LoopGraph, thread: string): Promise<boolean> {
  const snapshot = await graph.getState(config(thread));
  return snapshot.tasks.some((task) => task.interrupts.length > 0);
}

/** What the checkpoint says after the stream ended: paused at a question, done, or failed. */
async function endOf(graph: LoopGraph, thread: string): Promise<RunResult> {
  const snapshot = await graph.getState(config(thread));
  const pending = snapshot.tasks.flatMap((task) => task.interrupts);
  const first = pending[0];
  if (first !== undefined) return { kind: "paused", question: QuestionSchema.parse(first.value) };
  const { answer } = await loopStateOf(graph, thread);
  if (answer !== null) return { kind: "done", answer };
  return { kind: "failed", error: "the step ended without an answer" };
}

async function* graphEvents(
  graph: LoopGraph,
  input: LoopInput,
  thread: string,
  signal: AbortSignal,
): AsyncGenerator<RunEvent> {
  const chunks = await graph.stream(input, {
    ...config(thread),
    streamMode: ["tasks", "messages", "custom"],
    durability: "sync",
    signal,
  });
  for await (const chunk of chunks) {
    if (chunk[0] === "tasks") yield* taskEvents(chunk[1]);
    else if (chunk[0] === "messages") yield* tokenEvents(chunk[1][0], chunk[1][1]);
    else yield* customEvents(chunk[1]);
  }
}

/**
 * `app.stream(...)`: an AsyncIterable of events ending with exactly one terminal event.
 * `break` or the caller's signal closes the run (the internal controller aborts the graph).
 */
export async function* streamLoop(
  graph: LoopGraph,
  input: LoopInput,
  options: RunOptions,
): AsyncGenerator<RunEvent> {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    yield* graphEvents(graph, input, options.thread, controller.signal);
    yield await endOf(graph, options.thread);
  } catch (error) {
    if (controller.signal.aborted) yield { kind: "cancelled" };
    else yield { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    options.signal?.removeEventListener("abort", stop);
    controller.abort();
  }
}

/** `app.run(...)`: the same events, only the terminal one — so run and stream always agree. */
export async function runLoop(
  graph: LoopGraph,
  input: LoopInput,
  options: RunOptions,
): Promise<RunResult> {
  let result: RunResult = { kind: "failed", error: "no events" };
  for await (const event of streamLoop(graph, input, options)) {
    if (isTerminal(event)) result = event;
  }
  return result;
}

export const startInput = (text: string): LoopInput => ({ messages: [new HumanMessage(text)] });

/** Continues a paused run with an answer checked like any external input; not paused → rejected. */
export async function resumeInput(
  graph: LoopGraph,
  thread: string,
  answer: ApprovalAnswer,
): Promise<LoopInput> {
  if (!(await isPaused(graph, thread))) {
    throw new ResumeError("resume.not-paused", `Run ${thread} is not waiting for an answer`);
  }
  const parsed = ApprovalAnswerSchema.safeParse(answer);
  if (!parsed.success) throw new ResumeError("resume.invalid-answer", parsed.error.message);
  return new Command({ resume: parsed.data });
}

/** After a crash (not a pause): run from the last checkpoint; finished tool tasks are kept. */
export const recoverInput = (): LoopInput => null;
