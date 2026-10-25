import { watch } from "node:fs";
import { sep } from "node:path";

/**
 * The watch loop of `agboss dev` (#268 AC6): one pass at start, then one pass per burst of changes —
 * the changes of `debounce` milliseconds are one pass, a change during a pass makes one more after
 * it, passes never overlap. A pass is a short-lived child process (`dev.ts`): the ESM / tsx module
 * cache cannot reload a graph in a long-lived process.
 */

/** What `watchSources` watches and runs. */
export interface WatchOptions {
  /** The folder watched, recursively: the application's `src/`. */
  readonly folder: string;
  /** Quiet time after the last change before a pass starts, in milliseconds. */
  readonly debounce: number;
  /** Ends the loop: the watcher closes, a running pass is awaited. */
  readonly signal: AbortSignal;
  /** One pass: regenerates the types and reports what it found. */
  readonly pass: (changed: readonly string[]) => Promise<void>;
}

/** Folders a change in never starts a pass: dependencies, builds, the generated files. */
const IGNORED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "dist", ".agboss", ".git"]);

/** A change worth a pass: a source, a prompt or a profile file outside the ignored folders. */
export function isSourceChange(file: string): boolean {
  const parts = file.split(/[\\/]/);
  if (parts.some((part) => IGNORED_FOLDERS.has(part))) return false;
  return /\.(?:[cm]?ts|md|ya?ml|json)$/.test(file);
}

/** Resolves when `signal` aborts (at once when it already has). */
const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });

/** Runs passes as `options` says until its signal aborts; resolves when the last pass is done. */
export async function watchSources(options: WatchOptions): Promise<void> {
  const { signal } = options;
  let changed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let isRunning = false;
  let isPending = false;

  const runPass = (files: readonly string[]): void => {
    isRunning = true;
    running = options.pass(files).finally(() => {
      isRunning = false;
      if (isPending && !signal.aborted) {
        isPending = false;
        flush();
      }
    });
  };
  const flush = (): void => {
    timer = undefined;
    if (isRunning) {
      isPending = true;
      return;
    }
    const files = [...changed];
    changed = new Set();
    runPass(files);
  };
  const onChange = (file: string): void => {
    if (signal.aborted || !isSourceChange(file)) return;
    changed.add(file.split(/[\\/]/).join(sep));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, options.debounce);
  };

  const watcher = watch(options.folder, { recursive: true }, (_event, file) => {
    if (file !== null) onChange(file);
  });
  runPass([]);
  await abortOf(signal);
  watcher.close();
  if (timer !== undefined) clearTimeout(timer);
  await running;
}
