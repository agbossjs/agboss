import type { Class } from "../components/injection.js";
import { requireComponent } from "../components/metadata.js";
import { DEFAULT_TOOL_TIMEOUT_MS, ToolTimeoutError } from "../tools/index.js";
import type { ScriptedExpectation } from "./script-book.js";

/** How a scripted tool call fails (#262): as the real failure would reach the agent. */
export enum ToolFailure {
  /** The call ran past the tool's `timeoutMs`: the agent's model reads the timeout as a tool error. */
  Timeout = "timeout",
}

/** A tool's script: `mockTool(SearchJobsTool).thenFail(ToolFailure.Timeout)`. */
export interface ToolScript {
  /**
   * The next calls fail, one failure each, in order; the calls after them run the real tool. A
   * failure no call took fails the test at its end.
   */
  thenFail(...failures: readonly ToolFailure[]): ToolScript;
}

/** The error each failure is, as the tool's own code would throw it: what the agent then reads. */
const FAILURES: Readonly<Record<ToolFailure, (timeoutMs: number) => Error>> = {
  [ToolFailure.Timeout]: (timeoutMs) => new ToolTimeoutError(timeoutMs),
};

/** A tool instance: what the agent's loop calls. */
interface ToolInstance {
  run(input: unknown): Promise<unknown>;
}

const isToolInstance = (value: unknown): value is ToolInstance =>
  typeof value === "object" && value !== null && "run" in value && typeof value.run === "function";

/** One tool class's scripted failures; the real `run` for every call after them. */
class ToolFailures implements ToolScript, ScriptedExpectation {
  readonly #failures: ToolFailure[] = [];
  #position = 0;

  constructor(
    readonly tool: Class,
    private readonly timeoutMs: number,
  ) {}

  thenFail(...failures: readonly ToolFailure[]): this {
    this.#failures.push(...failures);
    return this;
  }

  /** The failure of the next call, if one is scripted. */
  take(): Error | undefined {
    const failure = this.#failures[this.#position];
    if (failure === undefined) return undefined;
    this.#position += 1;
    return FAILURES[failure](this.timeoutMs);
  }

  leftovers(): readonly string[] {
    const left = this.#failures.length - this.#position;
    if (left === 0) return [];
    return [`mockTool(${this.tool.name}): ${String(left)} scripted failure(s) never caused`];
  }
}

/**
 * The tool scripts of one test. The container still creates every tool (its dependencies real or
 * mocked); a scripted one's `run` fails first, then runs as written.
 */
export class ToolScripts {
  readonly #scripts = new Map<Class, ToolFailures>();

  constructor(private readonly onScripted: (script: ScriptedExpectation) => void) {}

  scriptOf(tool: Class): ToolScript {
    const existing = this.#scripts.get(tool);
    if (existing !== undefined) return existing;
    const kind = requireComponent(tool, "tool", "mockTool");
    const created = new ToolFailures(tool, kind.meta.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
    this.#scripts.set(tool, created);
    this.onScripted(created);
    return created;
  }

  /** Wraps a created tool's `run` when its class is scripted (the container's `onCreate`). */
  patch(instance: unknown): void {
    if (!isToolInstance(instance)) return;
    const script = [...this.#scripts.values()].find((item) => instance instanceof item.tool);
    if (script === undefined) return;
    const run = instance.run.bind(instance);
    const failing = (input: unknown): Promise<unknown> => {
      const failure = script.take();
      return failure === undefined ? run(input) : Promise.reject(failure);
    };
    Object.defineProperty(instance, "run", { value: failing });
  }
}
