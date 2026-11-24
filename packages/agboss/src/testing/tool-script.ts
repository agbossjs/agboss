import type { Class } from "../components/injection.js";
import { requireComponent } from "../components/metadata.js";
import { DEFAULT_TOOL_TIMEOUT, ToolTimeoutError } from "../tools/index.js";
import type { ScriptedExpectation } from "./script-book.js";
import type { Milliseconds } from "../units/index.js";

/** How a scripted tool call fails (#262): as the real failure would reach the agent. */
export enum ToolFailure {
  /** The call ran past the tool's `timeout`: the agent's model reads the timeout as a tool error. */
  Timeout = "timeout",
}

/** A tool's script: `mockTool(SearchJobsTool).thenReturn({ jobs: [] }).thenFail(ToolFailure.Timeout)`. */
export interface ToolScript {
  /**
   * The next calls return these outputs, one each, in order, without running the tool's `execute`
   * (what the agent's loop validates and reads as it would the real one's); the calls after them run
   * the real tool. An output no call took fails the test at its end.
   */
  thenReturn(...outputs: readonly unknown[]): ToolScript;
  /**
   * The next calls fail, one failure each, in order; the calls after them run the real tool. A
   * failure no call took fails the test at its end.
   */
  thenFail(...failures: readonly ToolFailure[]): ToolScript;
}

/** One scripted call: an output to return, or a failure to throw. */
type Scripted = { readonly returns: unknown } | { readonly fails: ToolFailure };

/** The error each failure is, as the tool's own code would throw it: what the agent then reads. */
const FAILURES: Readonly<Record<ToolFailure, (timeout: Milliseconds) => Error>> = {
  [ToolFailure.Timeout]: (timeout) => new ToolTimeoutError({ timeout }),
};

/** A tool instance: what the agent's loop calls. */
interface ToolInstance {
  execute(input: unknown): unknown;
}

const isToolInstance = (value: unknown): value is ToolInstance =>
  typeof value === "object" &&
  value !== null &&
  "execute" in value &&
  typeof value.execute === "function";

/** One tool class's scripted calls; the real `execute` for every call after them. */
class ToolCalls implements ToolScript, ScriptedExpectation {
  readonly #calls: Scripted[] = [];
  #position = 0;

  constructor(
    readonly tool: Class,
    private readonly timeout: Milliseconds,
  ) {}

  thenReturn(...outputs: readonly unknown[]): this {
    this.#calls.push(...outputs.map((returns) => ({ returns })));
    return this;
  }

  thenFail(...failures: readonly ToolFailure[]): this {
    this.#calls.push(...failures.map((fails) => ({ fails })));
    return this;
  }

  /** What the next call does, if one is scripted: return an output or fail. */
  take(): { readonly returns: unknown } | { readonly error: Error } | undefined {
    const next = this.#calls[this.#position];
    if (next === undefined) return undefined;
    this.#position += 1;
    return "fails" in next
      ? { error: FAILURES[next.fails](this.timeout) }
      : { returns: next.returns };
  }

  leftovers(): readonly string[] {
    const left = this.#calls.length - this.#position;
    if (left === 0) return [];
    return [`mockTool(${this.tool.name}): ${String(left)} scripted call(s) never made`];
  }
}

/**
 * The tool scripts of one test. The container still creates every tool (its dependencies real or
 * mocked); a scripted one's `execute` fails first, then runs as written.
 */
export class ToolScripts {
  readonly #scripts = new Map<Class, ToolCalls>();

  constructor(private readonly onScripted: (script: ScriptedExpectation) => void) {}

  scriptOf(tool: Class): ToolScript {
    const existing = this.#scripts.get(tool);
    if (existing !== undefined) return existing;
    const kind = requireComponent(tool, "tool", "mockTool");
    const created = new ToolCalls(tool, kind.meta.timeout ?? DEFAULT_TOOL_TIMEOUT);
    this.#scripts.set(tool, created);
    this.onScripted(created);
    return created;
  }

  /** Wraps a created tool's `execute` when its class is scripted (the container's `onCreate`). */
  patch(instance: unknown): void {
    if (!isToolInstance(instance)) return;
    const script = [...this.#scripts.values()].find((item) => instance instanceof item.tool);
    if (script === undefined) return;
    const execute = instance.execute.bind(instance);
    const scripted = (input: unknown): unknown => {
      const call = script.take();
      if (call === undefined) return execute(input);
      return "error" in call ? Promise.reject(call.error) : Promise.resolve(call.returns);
    };
    Object.defineProperty(instance, "execute", { value: scripted });
  }
}
