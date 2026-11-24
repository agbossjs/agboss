import { framesOfStack, isInternalFrame, spanText, type StackFrame } from "./source-span.js";

/**
 * How much of a stack an error report shows (#1325c, `AGBOSS_BACKTRACE`): none, the user's own frames,
 * or every frame.
 */
export enum BacktraceMode {
  Off = "0",
  Short = "1",
  Full = "full",
}

const MODES: readonly string[] = Object.values(BacktraceMode);

/** `AGBOSS_BACKTRACE`'s value as a mode; `undefined` for a value that is none. */
const modeOf = (value: string | undefined): BacktraceMode | undefined =>
  value !== undefined && MODES.includes(value) ? (value as BacktraceMode) : undefined;

/**
 * The mode a process runs in: `AGBOSS_BACKTRACE=0|1|full`, else `RUST_BACKTRACE` (`0`, `1`, `full`),
 * else `0` in production (`NODE_ENV=production`) and `1` everywhere else — a terminal, a test run.
 * A value that is no mode is ignored.
 */
export function backtraceModeOf(env: NodeJS.ProcessEnv = process.env): BacktraceMode {
  return (
    modeOf(env.AGBOSS_BACKTRACE) ??
    modeOf(env.RUST_BACKTRACE) ??
    (env.NODE_ENV === "production" ? BacktraceMode.Off : BacktraceMode.Short)
  );
}

/**
 * The module a frame's file is in, as Rust writes a module path: `src/credit/actions/charge.ts` under
 * the working directory is `credit::actions` (the `src` root is no module). A file outside the
 * working directory (a dependency, a global install) has none.
 */
export function modulePathOf(file: string, cwd: string): string | undefined {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (!file.startsWith(prefix)) return undefined;
  const folders = file.slice(prefix.length).split("/").slice(0, -1);
  const modules = folders[0] === "src" ? folders.slice(1) : folders;
  return modules.length === 0 ? undefined : modules.join("::");
}

/** `ChargeCardAction.execute` in `credit/actions` → `credit::actions::ChargeCardAction::execute`. */
const rustName = (frame: StackFrame, cwd: string): string => {
  const name =
    frame.functionName === undefined ? "<anonymous>" : frame.functionName.replaceAll(".", "::");
  const module = modulePathOf(frame.file, cwd);
  return module === undefined || frame.functionName === undefined ? name : `${module}::${name}`;
};

/** `./src/a.ts:44:38`: a path under the working directory as Rust prints it. */
function placeText(frame: StackFrame, cwd: string): string {
  const text = spanText(frame, cwd);
  return text.startsWith("/") ? text : `./${text}`;
}

/** One frame as two lines: `   0: ChargeCardAction::execute` and `             at ./src/a.ts:44:38`. */
const frameLines = (frame: StackFrame, index: number, cwd: string): readonly string[] => [
  `${String(index).padStart(4)}: ${rustName(frame, cwd)}`,
  `${" ".repeat(13)}at ${placeText(frame, cwd)}`,
];

/** The lines of a `Stack backtrace:` block for `stack`, per `mode`; none for `Off` and for no frame. */
export function backtraceLines(
  stack: string | undefined,
  mode: BacktraceMode,
  cwd: string = process.cwd(),
): readonly string[] {
  if (mode === BacktraceMode.Off) return [];
  const all = framesOfStack(stack);
  const shown = mode === BacktraceMode.Full ? all : all.filter((frame) => !isInternalFrame(frame));
  const omitted = all.length - shown.length;
  if (shown.length === 0) return [];
  const lines = shown.flatMap((frame, index) => frameLines(frame, index, cwd));
  if (omitted > 0) lines.push(`      [... ${String(omitted)} internal frames omitted ...]`);
  return lines;
}

/** The note that says how to see more, per `mode`. */
export const backtraceNote = (mode: BacktraceMode): string | undefined => {
  if (mode === BacktraceMode.Full) return undefined;
  const next = mode === BacktraceMode.Off ? BacktraceMode.Short : BacktraceMode.Full;
  const what = mode === BacktraceMode.Off ? "a backtrace" : "a full backtrace";
  return `note: Run with \`AGBOSS_BACKTRACE=${next}\` environment variable to display ${what}.`;
};
