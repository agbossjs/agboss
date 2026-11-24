import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where something stands in a user's source file (#1325c): a decorator call, a flow builder step.
 * Lines and columns count from 1. `endColumn` (exclusive), when known, ends the underline of a
 * rendered snippet; without it the renderer underlines the token at `column`.
 */
export interface SourceSpan {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn?: number;
}

/** A span with the words that say what it is in a rendered snippet: `^^^ reads stale …` / `--- first produced here`. */
export interface LabeledSpan {
  readonly span: SourceSpan;
  readonly label: string;
}

/** One frame of a JavaScript stack: the function (`ChargeCardAction.execute`) and where it ran. */
export interface StackFrame {
  readonly functionName: string | undefined;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** The framework's own source (`src/` or `dist/`): frames inside it are internal. */
const FRAMEWORK = fileURLToPath(new URL("../../", import.meta.url));

/** `at Foo.bar (file:///x.ts:1:2)`, `at async Foo.bar (/x.ts:1:2)`, `at /x.ts:1:2`. */
const FRAME = /^\s*at (?:async )?(?:(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/u;

/** A frame's file as a path (`file:` URLs unwrapped); `undefined` for `node:` internals and `<anonymous>`. */
function pathOf(location: string): string | undefined {
  const file = location.startsWith("file:") ? fileURLToPath(location) : location;
  return isAbsolute(file) ? file : undefined;
}

/**
 * The frames of a stack's text, innermost first — the text V8 made, so a source map (Node's
 * `--enable-source-maps`, a test runner's) already applies. The message line and lines that are no
 * frame are skipped; `node:` internals and `<anonymous>` are not frames of a file.
 */
export function framesOfStack(stack: string | undefined): readonly StackFrame[] {
  const frames: StackFrame[] = [];
  for (const text of (stack ?? "").split("\n")) {
    const match = FRAME.exec(text);
    const file = match?.[2] === undefined ? undefined : pathOf(match[2]);
    if (match === null || file === undefined) continue;
    const functionName = match[1] === undefined || match[1] === "" ? undefined : match[1];
    frames.push({ functionName, file, line: Number(match[3]), column: Number(match[4]) });
  }
  return frames;
}

/** Whether a frame is the framework's own, a dependency's, or a Node internal: not the user's code. */
export const isInternalFrame = (frame: StackFrame): boolean =>
  frame.file.startsWith(FRAMEWORK) || frame.file.includes("/node_modules/");

/** The user's innermost frame of a stack: where their code called into the framework. */
export const userFrameOf = (stack: string | undefined): StackFrame | undefined =>
  framesOfStack(stack).find((frame) => !isInternalFrame(frame));

/** How many frames a capture reads: the user's frame may stand under a deep framework stack. */
const CAPTURE_DEPTH = 40;

/**
 * The span of the user's code that called the framework — the first frame outside the framework, so
 * a decorator factory or a flow builder step called from a user's file is told apart from the
 * framework's own calls. `undefined` when no frame is a file (a REPL, `eval`).
 */
export function captureCallSite(): SourceSpan | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = CAPTURE_DEPTH;
  try {
    const frame = userFrameOf(new Error().stack);
    return frame === undefined
      ? undefined
      : { file: frame.file, line: frame.line, column: frame.column };
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** `src/a.ts:3:7`, or the absolute path when the file is outside the working directory. */
export function spanText(span: SourceSpan, cwd: string = process.cwd()): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const file = span.file.startsWith(prefix) ? span.file.slice(prefix.length) : span.file;
  return `${file}:${String(span.line)}:${String(span.column)}`;
}
