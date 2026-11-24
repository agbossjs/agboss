import { backtraceLines, backtraceModeOf, backtraceNote, type BacktraceMode } from "./backtrace.js";
import { spanTraceLines, type ExecutionSpanFrame } from "./span-trace.js";
import { spanText, userFrameOf, type LabeledSpan, type SourceSpan } from "./source-span.js";

/**
 * The runtime report of an error (#1325c), after `color-eyre`: the numbered chain of causes, where it
 * was thrown (`Location:`), where in the execution (`Span trace:`), the user's stack (`Stack
 * backtrace:`), the suggestion and the notes. It prints the framework's own sentences, names and
 * code positions — never `details`, a field of an error, a foreign error's message, or any stored
 * or model text.
 */

/** What an error carries for its report, besides its message (set when it is made). */
export interface ErrorDiagnostics {
  /** Where it is thrown in the user's source; absent = the first user frame of its stack. */
  readonly location?: SourceSpan;
  /** Other places that explain it, with the words that say how. */
  readonly secondarySpans?: readonly LabeledSpan[];
  /** What the execution was doing when it was made, innermost first. */
  readonly spanTrace?: readonly ExecutionSpanFrame[];
  /** Facts about the error that are not the message. */
  readonly notes?: readonly string[];
  /** What to do about it: one sentence. */
  readonly help?: string;
  /** Lines of code that make the change `help` asks for, as written. */
  readonly suggestionPatch?: string;
}

/** What `error.format(options?)` takes. */
export interface ErrorFormatOptions {
  /** How much of the stack: default from `AGBOSS_BACKTRACE` (`RUST_BACKTRACE`), see `backtraceModeOf`. */
  readonly backtrace?: BacktraceMode;
  /** Paths are shown relative to it. Default: the working directory. */
  readonly cwd?: string;
}

/** The error as the report sees it: its facts, none of them a stored value. */
export interface ReportedError extends Error {
  readonly location?: SourceSpan | undefined;
  readonly spanTrace: readonly ExecutionSpanFrame[];
  readonly notes: readonly string[];
  readonly help?: string | undefined;
  readonly suggestionPatch?: string | undefined;
}

/** The longest chain a report walks: a cause that points back at an earlier one ends it too. */
const MAX_CHAIN = 16;

/** `error`, its cause, that cause's cause, … */
export function chainOf(error: Error): readonly Error[] {
  const chain: Error[] = [];
  for (
    let current: unknown = error;
    current instanceof Error && !chain.includes(current) && chain.length < MAX_CHAIN;
    current = current.cause
  )
    chain.push(current);
  return chain;
}

/** What a report says of one error in a chain: a framework error's sentence, a foreign error's name only. */
function chainEntryText(entry: Error, isFramework: (error: Error) => boolean): string {
  const text = isFramework(entry)
    ? entry.message
    : `${entry.name} (message withheld: not a framework error)`;
  return text.split("\n").join(`\n${" ".repeat(7)}`);
}

/** The numbered chain of causes: a framework error's sentence, a foreign error's name only. */
const chainLines = (error: Error, isFramework: (error: Error) => boolean): readonly string[] =>
  chainOf(error).map(
    (entry, index) => `${String(index).padStart(4)}: ${chainEntryText(entry, isFramework)}`,
  );

/** `Location:`, `Span trace:` and `Stack backtrace:`: each block apart by a blank line, none when empty. */
function placeBlocks(
  error: ReportedError,
  mode: BacktraceMode,
  cwd: string,
): readonly (readonly string[])[] {
  const location = error.location ?? userSpanOf(error);
  const stack = backtraceLines(error.stack, mode, cwd);
  return [
    location === undefined ? [] : ["Location:", `   ${spanText(location, cwd)}`],
    error.spanTrace.length === 0 ? [] : ["Span trace:", ...spanTraceLines(error.spanTrace, cwd)],
    stack.length === 0 ? [] : ["Stack backtrace:", ...stack],
  ];
}

/** The suggestion, its patch, the notes, and how to see more of the stack. */
const tailLines = (error: ReportedError, mode: BacktraceMode): readonly string[] => [
  ...(error.help === undefined ? [] : [`Suggestion: ${error.help}`]),
  ...(error.suggestionPatch === undefined ? [] : [error.suggestionPatch]),
  ...error.notes.map((note) => `note: ${note}`),
  ...[backtraceNote(mode)].filter((note) => note !== undefined),
];

/**
 * The report of `error`: see the module's comment. `isFramework` tells an `AGBossError` (whose
 * message is the framework's own sentence) from any other error (named, never quoted).
 */
export function formatError(
  error: ReportedError,
  isFramework: (error: Error) => boolean,
  options: ErrorFormatOptions = {},
): string {
  const { backtrace = backtraceModeOf(), cwd = process.cwd() } = options;
  const blocks = [
    ["Error:", ...chainLines(error, isFramework)],
    ...placeBlocks(error, backtrace, cwd),
    tailLines(error, backtrace),
  ];
  return blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join("\n"))
    .join("\n\n");
}

/** The user's frame of the error's stack as a span: where their code called what threw. */
export function userSpanOf(error: Error): SourceSpan | undefined {
  const frame = userFrameOf(error.stack);
  return frame === undefined
    ? undefined
    : { file: frame.file, line: frame.line, column: frame.column };
}
