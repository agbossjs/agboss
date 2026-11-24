import { spanText, type SourceSpan } from "./source-span.js";

/**
 * One frame of a logical `Span trace` (#1325c, after Rust's `tracing-error`): where in the execution
 * an error was made — a step, a workflow run — not where in the JavaScript stack. The fields are the
 * names a project chose (a workflow's name, a node's id, a visit number); never a value of the
 * run's data.
 */
export interface ExecutionSpanFrame {
  /** `agboss::action::execute`. */
  readonly name: string;
  /** `{ name: "charge-card-action", visit: 1 }`: names and counters only. */
  readonly fields: Readonly<Record<string, string | number>>;
  /** The declaration of the step's component, when it is known. */
  readonly location?: SourceSpan;
}

type SpanTraceSource = () => readonly ExecutionSpanFrame[];

let source: SpanTraceSource | undefined;

/**
 * Where the runtime says which execution the current async context runs in. The runtime registers
 * it once; an error made inside a step then carries the spans around it, across every `await`.
 */
export function registerSpanTraceSource(next: SpanTraceSource): void {
  source = next;
}

/** The spans around the current async context, innermost first; none outside an execution. */
export function currentSpanTrace(): readonly ExecutionSpanFrame[] {
  try {
    return source?.() ?? [];
  } catch {
    // making an error must never fail for a frame that is not whole: the trace is a courtesy
    return [];
  }
}

/** The longest text a field shows: a name, not a payload. */
const MAX_FIELD_TEXT = 80;

const fieldText = (value: string | number): string =>
  typeof value === "number" ? String(value) : JSON.stringify(value.slice(0, MAX_FIELD_TEXT));

/** The lines of a `Span trace:` block. */
export function spanTraceLines(
  frames: readonly ExecutionSpanFrame[],
  cwd: string = process.cwd(),
): readonly string[] {
  return frames.flatMap((frame, index) => {
    const fields = Object.entries(frame.fields).map(([key, value]) => `${key}=${fieldText(value)}`);
    const head = `${String(index).padStart(4)}: ${[frame.name, ...fields].join(" ")}`;
    return frame.location === undefined
      ? [head]
      : [head, `${" ".repeat(8)}at ${spanText(frame.location, cwd)}`];
  });
}
