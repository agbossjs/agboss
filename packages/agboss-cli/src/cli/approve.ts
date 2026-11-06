import {
  AGBossError,
  PauseKind,
  type App,
  type ExecutionOutput,
  type PendingPause,
  type ResumeRequest,
} from "@agboss/core";
import type { ToolCallApprovalDecisionDto } from "@agboss/core/dto";

/** Asks the human a question; undefined when input ended (Ctrl+D). */
export type Ask = (question: string) => Promise<string | undefined>;

/** Wraps a turn's work (loader, interrupt key); hands the work a signal to stop it. */
export type Busy = <T>(work: (signal: AbortSignal | undefined) => Promise<T>) => Promise<T>;

const idle: Busy = (work) => work(undefined);

/** The terminal's decision on a call; who answered is the thread's owner (the terminal's run). */
export function terminalDecision(approved: boolean): ToolCallApprovalDecisionDto {
  return approved ? { approved } : { approved, reason: "declined in the terminal" };
}

/** What the terminal answers a pause with: an approval's yes / no, a question's typed or free answer. */
type TerminalAnswer =
  | { readonly decision: unknown; readonly reply?: never }
  | { readonly reply: string; readonly decision?: never };

/** A question's answer as typed (#659): a JSON object is the answer DTO, anything else a reply. */
function questionAnswerOf(text: string): TerminalAnswer {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) return { decision: parsed };
  } catch {
    // not JSON: a free-text reply, read by the role's interpreter
  }
  return { reply: text };
}

/** Asks about one pause: an approval's yes / no, a question's answer (#659). */
async function terminalAnswer(
  pause: PendingPause,
  ask: Ask,
  retry: string,
): Promise<TerminalAnswer> {
  if (pause.kind === PauseKind.Question) {
    const reply = await ask(
      `${retry}${pause.step} asks ${JSON.stringify(pause.ask)} — your answer: `,
    );
    return questionAnswerOf((reply ?? "").trim());
  }
  const question = pause.ask;
  const reply = await ask(
    `${pause.step} wants to call ${question.tool} ${JSON.stringify(question.arguments)} — approve? [y/N] `,
  );
  return { decision: terminalDecision(/^y(es)?$/i.test((reply ?? "").trim())) };
}

/** Why a question's answer was not taken, to ask again; anything else is thrown on. */
function retryOf(error: unknown): string {
  const code =
    error instanceof AGBossError ? (error.constructor as { code?: string }).code : undefined;
  if (code !== "pause.uninterpretable-reply" && code !== "dto.invalid") throw error;
  return `${error instanceof Error ? error.message : String(error)}\n`;
}

/**
 * A paused run asks in the terminal, one pause after another, then continues in the same process:
 * an approval as yes / no, a question (#659) as its answer — JSON for the typed answer, else free
 * text for the role's interpreter, asked again when it is not taken. Only the pauses its thread's
 * owner answers come with an id; a channel's own pause is answered where the channel asked (the run
 * stays paused).
 */
export async function untilDone(
  first: ExecutionOutput,
  app: Pick<App, "resume">,
  ask: Ask,
  busy: Busy = idle,
): Promise<ExecutionOutput> {
  let result = first;
  let retry = "";
  for (;;) {
    const waiting = result.pending.find((pause) => pause.pauseId !== undefined);
    if (waiting?.pauseId === undefined) return result;
    const request = { pauseId: waiting.pauseId, ...(await terminalAnswer(waiting, ask, retry)) };
    try {
      result = await busy((signal) => app.resume(request as ResumeRequest, { signal }));
      retry = "";
    } catch (error) {
      if (waiting.kind !== PauseKind.Question) throw error;
      retry = retryOf(error);
    }
  }
}

/** First line under an answer: which conversation, and its trace when tracing is on. */
export function threadLine(result: Pick<ExecutionOutput, "threadId" | "traceUrl">): string {
  return result.traceUrl === undefined
    ? `thread ${result.threadId}`
    : `thread ${result.threadId} · ${result.traceUrl}`;
}

/**
 * `memory: conversation-compaction turns 1–5 → summary 1/10` when this turn compacted the
 * conversation — one part per compaction that did (#120 PR 3).
 */
export function memoryLine(result: Pick<ExecutionOutput, "compacted">): string | undefined {
  const compacted = result.compacted ?? [];
  if (compacted.length === 0) return undefined;
  const parts = compacted.map(
    (c) =>
      `${c.compaction} turns ${String(c.fromTurn)}–${String(c.toTurn)} → summary ${String(c.summaries)}/${String(c.summaryQueueLength)}`,
  );
  return `memory: ${parts.join(" · ")}`;
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
