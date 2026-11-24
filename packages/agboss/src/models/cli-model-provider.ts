import { spawn, type ChildProcess } from "node:child_process";
import { ZERO_USAGE } from "../finops/usage.js";
import { ModelCallError } from "./circuit-breaker.js";
import { ModelFailure } from "./model-failure.js";
import { ModelProviderFailureError } from "./transport/failure-error.js";
import type {
  ModelProviderRequest,
  ModelProviderResponse,
  ModelProviderStream,
  ModelProviderStreamResult,
  ModelProviderUsage,
} from "./transport/transport.js";

/**
 * A model served by a command-line tool (#1313g): the class says which process one call runs
 * (`invocationOf`), the base runs it — its whole process group, ended with the call: a caller's
 * cancel, the provider's `timeout` (both the request's `signal`) and a call that ends all kill it, so
 * no child outlives the call — and maps what happens to the errors the framework's retry policy,
 * breaker and fallback read: a command that cannot start is a `ModelCallError` (`model.cli-failed`:
 * nothing to retry), a non-zero exit a `ModelProviderFailureError` (`ServerError`: the provider's).
 * A CLI that bills nothing (a subscription) leaves out `cost`, and its calls are `CostSource.Unpriced`.
 */

/** The process one model call runs. */
export interface CliInvocation {
  /** The executable. */
  readonly command: string;
  /** Its arguments. */
  readonly args: readonly string[];
  /** Added to the process's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** The working directory; default: the application's. */
  readonly cwd?: string;
  /** Written to the process's stdin, which is then closed. */
  readonly stdin?: string;
}

/** What a finished call tells: the text, and — when the CLI reports them — what it used and cost. */
export type CliResult = Omit<ModelProviderResponse, "toolCalls">;

const STDERR_TAIL = 2000;
const NO_USAGE: ModelProviderUsage = { inputTokens: 0, outputTokens: 0 };

/** Ends the process and its children (a process group of its own, so `kill(-pid)` reaches them all). */
function endGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** One running call: its stdout lines as they come, and how it ended. */
interface Running {
  readonly lines: AsyncIterable<string>;
  readonly done: Promise<void>;
  /** Ends the process group now (a call that stops reading, or ends). */
  readonly end: () => void;
}

/** The base of a `@ModelProvider` class whose models are a command-line tool: a transport with `complete` and `stream`. */
export abstract class CliModelProvider {
  /** The process `request` runs. */
  protected abstract invocationOf(request: ModelProviderRequest): CliInvocation;

  /**
   * What a finished call's whole stdout means. Default: the text, no usage. Override to read a JSON
   * result's text, tokens and cost.
   */
  protected resultOf(stdout: string): CliResult {
    return { text: stdout.trim(), usage: NO_USAGE };
  }

  /**
   * One stdout line of a streamed call: the text it carries, or `undefined` for none (a bookkeeping
   * frame). Inspect the CLI's `init` frame here and throw `ModelCallError` (`model.cli-failed`) to end
   * the call, fail-closed, when it shows something the application did not allow. Default: the line.
   */
  protected parseStreamLine(line: string): string | undefined {
    return `${line}\n`;
  }

  /** Checks at start that the CLI is there (the provider's `onInit`); throw to refuse to start. */
  verifyStartup?(): void | Promise<void>;

  /** The provider's lifecycle hook: runs `verifyStartup` before the first call. */
  async onInit(): Promise<void> {
    await this.verifyStartup?.();
  }

  #run(request: ModelProviderRequest): Running {
    const invocation = this.invocationOf(request);
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = (): void => {
      endGroup(child);
    };
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted) stop();
    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.stdin ?? "");
    const exited = exitOf(child, invocation.command, request.signal, this.constructor.name);
    const done = exited.finally(() => {
      request.signal.removeEventListener("abort", stop);
      stop();
    });
    done.catch(() => undefined);
    return { lines: linesOf(child), done, end: stop };
  }

  /** One chat call: the process runs to its end, its output is the answer. */
  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const { lines, done, end } = this.#run(request);
    let stdout = "";
    try {
      for await (const line of lines) stdout += `${line}\n`;
      await done;
    } finally {
      end();
    }
    return this.resultOf(stdout);
  }

  /** The same call streamed: the text of each line as it comes, the call's result at its end. */
  stream(request: ModelProviderRequest): ModelProviderStream {
    const { lines, done, end } = this.#run(request);
    const parse = (line: string): string | undefined => this.parseStreamLine(line);
    async function* textOf(): AsyncGenerator<string> {
      try {
        for await (const line of lines) {
          const piece = parse(line);
          if (piece === undefined || piece === "") continue;
          yield piece;
        }
        await done;
      } finally {
        end(); // a stream not read to its end, or refused by `parseStreamLine`, ends its process
      }
    }
    const result = (async (): Promise<ModelProviderStreamResult> => {
      await done.catch(() => undefined);
      return { usage: ZERO_USAGE };
    })();
    return { textStream: textOf(), result };
  }
}

/** How the process ended: it resolves for exit 0; else the error the framework's retry and breaker read. */
function exitOf(
  child: ChildProcess,
  command: string,
  signal: AbortSignal,
  provider: string,
): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
  });
  return new Promise<void>((resolve, reject) => {
    child.once("error", (cause) => {
      const message = `${command} could not start: ${cause.message}`;
      reject(new ModelCallError({ code: "model.cli-failed", provider, message, cause }));
    });
    child.once("close", (code, ended) => {
      if (signal.aborted) reject(abortReasonOf(signal));
      else if (code === 0) resolve();
      else {
        const how = ended ?? `exit code ${String(code)}`;
        const cause = new Error(`${command} ended with ${how}: ${stderr}`);
        reject(new ModelProviderFailureError({ failure: ModelFailure.ServerError, cause }));
      }
    });
  });
}

/** Why a call was aborted, as an error. */
const abortReasonOf = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));

/** The lines of a child's stdout, as they come. */
async function* linesOf(child: ChildProcess): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of child.stdout ?? []) {
    pending += (chunk as Buffer).toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    yield* parts;
  }
  if (pending !== "") yield pending;
}
