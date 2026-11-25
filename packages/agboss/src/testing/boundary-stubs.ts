import type { Class } from "../components/injection.js";
import { requireComponent } from "../components/metadata.js";
import type { A2AMessageInput } from "../a2a/a2a-types.js";
import type { A2ATaskResult } from "../a2a/client/a2a-client-options.js";
import type { RagRetrieval } from "../rag/types.js";
import { TestFailure } from "./errors.js";
import type { ScriptBook, ScriptedExpectation } from "./script-book.js";

/**
 * The stubs of the application's other boundaries (#1328): a knowledge base (`mockRag(Handbook)`)
 * and an A2A peer (`mockA2A(BillingAgent)`) — one line each, like `mockTool`. The container still
 * creates the class (its `deps`, its pipeline: a knowledge base's scope, reranking, PII policies and
 * spend run on what the stub returns); only the one call that leaves the process is scripted. A
 * call with nothing scripted fails the test (`test.script-exhausted`), and so does a script no call took.
 */

/** A scripted boundary: the answers in order, the failures in order, the calls it got. */
export interface BoundaryStub<TCall, TResult> {
  /** The next calls answer with these, in order. */
  thenReturn(...results: readonly TResult[]): this;
  /** The next calls fail with these, in order, after the answers scripted before. */
  thenFail(...errors: readonly Error[]): this;
  /** Forgets what is scripted and what was called. */
  reset(): this;
  /** What each call asked, in order. */
  readonly calls: readonly TCall[];
}

/** A knowledge base's stub: each `retrieve` takes the next retrieval; `calls` are the queries. */
export type RagStub = BoundaryStub<string, RagRetrieval>;

/** An A2A peer's stub: each `execute(input)` / `send(message)` takes the next result. */
export type A2AStub<TInput = unknown, TResult = unknown> = BoundaryStub<TInput, TResult>;

type Step<TResult> = { readonly result: TResult } | { readonly error: Error };

/** One stubbed class's script. */
class Script<TCall, TResult> implements BoundaryStub<TCall, TResult>, ScriptedExpectation {
  readonly #steps: Step<TResult>[] = [];
  readonly #calls: TCall[] = [];
  #position = 0;

  constructor(
    readonly target: Class,
    private readonly label: string,
    private readonly book: ScriptBook,
  ) {}

  get calls(): readonly TCall[] {
    return this.#calls;
  }

  thenReturn(...results: readonly TResult[]): this {
    this.#steps.push(...results.map((result) => ({ result })));
    return this;
  }

  thenFail(...errors: readonly Error[]): this {
    this.#steps.push(...errors.map((error) => ({ error })));
    return this;
  }

  reset(): this {
    this.#steps.length = 0;
    this.#calls.length = 0;
    this.#position = 0;
    return this;
  }

  /** The next call: its scripted answer, its scripted failure, or a reported exhausted script. */
  take(call: TCall): Promise<TResult> {
    this.#calls.push(call);
    const step = this.#steps[this.#position];
    if (step === undefined) {
      const message = `${this.label}(${this.target.name}): called with nothing scripted left — add .thenReturn(…)`;
      return Promise.reject(
        this.book.report(new TestFailure({ code: "test.script-exhausted", message })),
      );
    }
    this.#position += 1;
    return "error" in step ? Promise.reject(step.error) : Promise.resolve(step.result);
  }

  leftovers(): readonly string[] {
    const left = this.#steps.length - this.#position;
    return left === 0
      ? []
      : [`${this.label}(${this.target.name}): ${String(left)} scripted step(s) never called`];
  }
}

/** A method of a created instance, replaced. */
const replace = (instance: object, method: string, value: unknown): void => {
  Object.defineProperty(instance, method, { value, configurable: true });
};

/** The boundary stubs of one test: found by the class of each instance the container creates. */
export class BoundaryStubs {
  readonly #rag = new Map<Class, Script<string, RagRetrieval>>();
  readonly #a2a = new Map<Class, Script<unknown, unknown>>();

  constructor(
    private readonly book: ScriptBook,
    private readonly onScripted: (script: ScriptedExpectation) => void,
  ) {}

  ragOf(rag: Class): RagStub {
    requireComponent(rag, "rag", "mockRag");
    return this.#scriptOf(this.#rag, rag, "mockRag");
  }

  a2aOf(agent: Class): A2AStub {
    requireComponent(agent, "a2a-agent", "mockA2A");
    return this.#scriptOf(this.#a2a, agent, "mockA2A");
  }

  #scriptOf<TCall, TResult>(
    scripts: Map<Class, Script<TCall, TResult>>,
    target: Class,
    label: string,
  ): Script<TCall, TResult> {
    const existing = scripts.get(target);
    if (existing !== undefined) return existing;
    const script = new Script<TCall, TResult>(target, label, this.book);
    scripts.set(target, script);
    this.onScripted(script);
    return script;
  }

  /** Replaces the call that leaves the process on a stubbed instance (the container's `onCreate`). */
  patch(instance: unknown): void {
    if (typeof instance !== "object" || instance === null) return;
    const rag = [...this.#rag.values()].find((script) => instance instanceof script.target);
    if (rag !== undefined) replace(instance, "retrieve", (query: string) => rag.take(query));
    const a2a = [...this.#a2a.values()].find((script) => instance instanceof script.target);
    if (a2a === undefined) return;
    replace(instance, "execute", (input: unknown) => a2a.take(input));
    replace(
      instance,
      "send",
      (message: A2AMessageInput) => a2a.take(message) as Promise<A2ATaskResult>,
    );
  }
}
