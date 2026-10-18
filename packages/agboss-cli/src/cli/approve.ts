import { type App, type ExecutionOutput } from "agboss";
import type { ToolCallApprovalDecisionDto } from "agboss/dto";
import { userInfo } from "node:os";

/** Asks the human a question; undefined when input ended (Ctrl+D). */
export type Ask = (question: string) => Promise<string | undefined>;

/** Wraps a turn's work (loader, interrupt key); hands the work a signal to stop it. */
export type Busy = <T>(work: (signal: AbortSignal | undefined) => Promise<T>) => Promise<T>;

const idle: Busy = (work) => work(undefined);

/** The terminal's decision on a call: `by` is the OS user who answered. */
export function terminalDecision(approved: boolean): ToolCallApprovalDecisionDto {
  const by = userInfo().username;
  return approved ? { approved, by } : { approved, by, feedback: "declined in the terminal" };
}

/** A paused run asks in the terminal, then continues in the same process. */
export async function untilDone(
  first: ExecutionOutput,
  app: Pick<App, "resume">,
  ask: Ask,
  busy: Busy = idle,
): Promise<ExecutionOutput> {
  let result = first;
  while (result.pause !== undefined) {
    const { agent, tool, args } = result.pause;
    const reply = await ask(
      `${agent} wants to call ${tool} ${JSON.stringify(args)} — approve? [y/N] `,
    );
    const approved = /^y(es)?$/i.test((reply ?? "").trim());
    const { threadId: thread } = result;
    const decision = terminalDecision(approved);
    result = await busy((signal) => app.resume(thread, decision, { signal }));
  }
  return result;
}

/** First line under an answer: which conversation, and its trace when tracing is on. */
export function threadLine(result: Pick<ExecutionOutput, "threadId" | "traceUrl">): string {
  return result.traceUrl === undefined
    ? `thread ${result.threadId}`
    : `thread ${result.threadId} · ${result.traceUrl}`;
}

/** `memory: turns 1–5 → summary 1/10` when this turn compacted the conversation. */
export function memoryLine(result: Pick<ExecutionOutput, "compacted">): string | undefined {
  const c = result.compacted;
  if (c === undefined) return undefined;
  return `memory: turns ${String(c.fromTurn)}–${String(c.toTurn)} → summary ${String(c.summaries)}/${String(c.keep)}`;
}

/** One line under an answer: the path and where the execution finished (or that it waits). */
export function summaryLine(result: Pick<ExecutionOutput, "path" | "finish" | "status">): string {
  const path = result.path.length > 0 ? result.path.join(" → ") : "(none)";
  return `${path} · ${result.finish === undefined ? result.status : `finish ${result.finish.name}`}`;
}

/** What an execution's output says, as the terminal shows it: its `text`, else its JSON. */
export function outputText(result: Pick<ExecutionOutput, "output">): string {
  const { output } = result;
  if (typeof output === "object" && output !== null && "text" in output) {
    if (typeof output.text === "string") return output.text;
  }
  return output === undefined ? "(no output)" : JSON.stringify(output, null, 2);
}
