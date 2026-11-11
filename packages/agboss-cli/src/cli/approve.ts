import {
  AGBossError,
  PauseKind,
  type App,
  type ExecutionOutput,
  type DecisionResumeRequest,
  type PendingPause,
  type ReplyResumeRequest,
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
  | { readonly kind: "decision"; readonly decision: unknown }
  | { readonly kind: "reply"; readonly reply: string }
  | { readonly kind: "invalid"; readonly problem: string };

/** How a question's answer is typed (#891): the prompt says it, `questionAnswerOf` reads it. */
const ANSWER_MODES = "a line starting with { is the typed answer as JSON, anything else a reply";

/**
 * A question's answer as typed (#659, #891: the mode is explicit) — a line starting with `{` is the
 * answer DTO and must be JSON (else it is asked again, never sent as a reply); anything else is a
 * free-text reply for the role's interpreter, `42` and `["a"]` too.
 */
function questionAnswerOf(text: string): TerminalAnswer {
  if (!text.startsWith("{")) return { kind: "reply", reply: text };
  try {
    const decision: unknown = JSON.parse(text);
    return { kind: "decision", decision };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "invalid", problem: `not valid JSON (${reason}) — ${ANSWER_MODES}` };
  }
}

/** The request that answers `pauseId` with a decision or a reply: one of the two, never both. */
function resumeRequestOf(
  pauseId: string,
  answer: Exclude<TerminalAnswer, { readonly kind: "invalid" }>,
): ResumeRequest {
  if (answer.kind === "reply") {
    const reply: ReplyResumeRequest = { pauseId, reply: answer.reply };
    return reply;
  }
  const decision: DecisionResumeRequest = { pauseId, decision: answer.decision };
  return decision;
}

/** Asks about one pause: an approval's yes / no, a question's answer (#659). */
async function terminalAnswer(
  pause: PendingPause,
  ask: Ask,
  retry: string,
): Promise<TerminalAnswer> {
  if (pause.kind === PauseKind.Question) {
    const reply = await ask(
      `${retry}${pause.step} asks ${JSON.stringify(pause.ask)} — your answer (${ANSWER_MODES}): `,
    );
    return questionAnswerOf((reply ?? "").trim());
  }
  const question = pause.ask;
  const reply = await ask(
    `${pause.step} wants to call ${question.tool} ${JSON.stringify(question.arguments)} — approve? [y/N] `,
  );
  return { kind: "decision", decision: terminalDecision(/^y(es)?$/i.test((reply ?? "").trim())) };
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
 * an approval as yes / no, a question (#659) as its answer — a line starting with `{` the typed
 * answer as JSON, anything else free text for the role's interpreter (#891), asked again when it is
 * not taken or is no JSON. Only the pauses its thread's
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
    const answer = await terminalAnswer(waiting, ask, retry);
    if (answer.kind === "invalid") {
      retry = `${answer.problem}\n`;
      continue;
    }
    const request = resumeRequestOf(waiting.pauseId, answer);
    try {
      result = await busy((signal) => app.resume(request, { signal }));
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
