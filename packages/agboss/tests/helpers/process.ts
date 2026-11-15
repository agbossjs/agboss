/**
 * A child process a test runs, awaited (#630) — never `spawnSync` / `execFileSync` / `execSync`
 * (ESLint forbids them in this package's tests). A synchronous one holds the vitest fork's event
 * loop: held 60 s, the fork's pending report to vitest (birpc's `onTaskUpdate`) times out, the
 * fork's run rejects, and vitest 3's forks pool then skips every `singleFork` project still to
 * come — the fault suite — leaving one unhandled error and a summary that counts only the files
 * that ran.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** What a finished child process left: its exit code (`null` when a signal ended it) and output. */
export interface ProcessRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, then closed. */
  readonly input?: string;
}

/** Runs `command` with `args` to its end; a child that cannot start (ENOENT, …) rejects. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

/** `runProcess`, its stdout — and a failure, naming the command and its stderr, unless it exits 0. */
export async function outputOf(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<string> {
  const run = await runProcess(command, args, options);
  if (run.status !== 0) {
    const ended = run.signal ?? `exit ${String(run.status)}`;
    throw new Error(`${command} ${args.join(" ")} failed (${ended}):\n${run.stderr}`);
  }
  return run.stdout;
}

/** `node <args…>` with this process's own Node. */
export const runNode = (
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessRun> => runProcess(process.execPath, args, options);

/** A child process the test can talk to over IPC (#1128): its messages, its barrier, its end. */
export interface NodeChild {
  readonly process: ChildProcess;
  /** Every message the child `report`ed so far, in order. */
  readonly messages: () => readonly unknown[];
  /** Resolves with the first message (past or future) `matches`; rejects if the child ends first. */
  readonly waitFor: (
    matches: (message: unknown) => boolean,
    timeoutMs?: number,
  ) => Promise<unknown>;
  /** A message for the child's `nextFromParent()`. */
  readonly send: (message: unknown) => void;
  readonly exited: Promise<ProcessRun>;
}

/**
 * `node <args…>` with an IPC channel next to stdout and stderr. The child answers with `report()`
 * from `child-channel.ts`; its stdout / stderr are only logs, collected for the failure message.
 */
export function startNode(args: readonly string[], options: ProcessOptions = {}): NodeChild {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  const watchers = new Set<() => void>();
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.on("message", (message) => {
    messages.push(message);
    for (const watcher of [...watchers]) watcher();
  });
  const exited = new Promise<ProcessRun>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
      for (const watcher of [...watchers]) watcher();
    });
  });
  // a rejection nobody awaits (a child that never started) must not crash the vitest fork
  exited.catch(() => undefined);
  const waitFor: NodeChild["waitFor"] = (matches, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        watchers.delete(check);
        reject(
          new Error(`no matching message from the child in ${String(timeoutMs)} ms\n${stderr}`),
        );
      }, timeoutMs);
      function check(): void {
        const found = messages.find(matches);
        const ended = child.exitCode !== null || child.signalCode !== null;
        if (found === undefined && !ended) return;
        clearTimeout(deadline);
        watchers.delete(check);
        if (found !== undefined) resolve(found);
        else reject(new Error(`the child ended without the message\n${stderr}`));
      }
      watchers.add(check);
      check();
    });
  return {
    process: child,
    messages: () => messages,
    waitFor,
    send: (message) => child.send(message as never),
    exited,
  };
}

/** `startNode` to its end: what the child `report`ed besides the exit and the logs. */
export async function runNodeReporting(
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessRun & { readonly messages: readonly unknown[] }> {
  const child = startNode(args, options);
  const run = await child.exited;
  return { ...run, messages: child.messages() };
}
