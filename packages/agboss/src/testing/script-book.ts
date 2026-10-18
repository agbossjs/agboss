import { ComponentScript } from "./component-script.js";
import { TestFailure } from "./errors.js";

export { ComponentScript, type ReturnedValue } from "./component-script.js";
export type { ChatLine, ModelRequest, ModelScript, WhenScript } from "./model-script.js";

/** Something a test scripted that can be left unused: a model's script, a tool's failures. */
export interface ScriptedExpectation {
  /** What was left unused, one line each; empty when everything was used. */
  leftovers(): readonly string[];
}

/** Script keys whose calls carry their step's input: agents and model routers (not guards). */
const bindsInput = (key: string): boolean =>
  key.startsWith("agent:") || (key.startsWith("router:") && !key.startsWith("router:guard:"));

/**
 * Every component's script in one test, shared by every app the test opens — so a run resumed in a
 * new app continues the same script. Failures that must fail the test are kept until reported.
 */
export class ScriptBook {
  readonly #scripts = new Map<string, ComponentScript>();
  readonly #labels = new Map<string, string>();
  readonly #failures: Error[] = [];
  readonly #expectations: ScriptedExpectation[] = [];
  #toolCallIds = 0;

  /** How the test names the component behind a key (its class), for messages. */
  name(key: string, label: string): void {
    this.#labels.set(key, label);
  }

  scriptOf(key: string): ComponentScript {
    const existing = this.#scripts.get(key);
    if (existing !== undefined) return existing;
    const created = new ComponentScript(this.#labels.get(key) ?? key, bindsInput(key));
    this.#scripts.set(key, created);
    return created;
  }

  /** Another script whose leftovers fail the test (`mockTool(…).thenFail(…)`). */
  expect(expectation: ScriptedExpectation): void {
    this.#expectations.push(expectation);
  }

  /** A tool call id unique within the test (results are keyed by it). */
  nextToolCallId(): string {
    this.#toolCallIds += 1;
    return `call-${String(this.#toolCallIds)}`;
  }

  /** Remembers a failure the test must see, even if a run swallowed it (a tool error, a guard). */
  report(failure: Error): Error {
    this.#failures.push(failure);
    return failure;
  }

  /** The first failure reported since the last call, if any (then forgotten). */
  takeFailure(): Error | undefined {
    const [first] = this.#failures;
    this.#failures.length = 0;
    return first;
  }

  /**
   * The test's leftovers as one failure (#262 AC7): every `thenReturn` turn no call took, every
   * `when(…)` nothing matched, every scripted tool failure not caused; `undefined` when none.
   */
  leftoverFailure(): TestFailure | undefined {
    const lines = [...this.#scripts.values(), ...this.#expectations].flatMap((script) =>
      script.leftovers(),
    );
    if (lines.length === 0) return undefined;
    const message = `the test left scripts unused — a script is an expectation:\n  ${lines.join("\n  ")}`;
    return new TestFailure("test.unused-script", message);
  }
}
