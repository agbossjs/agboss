import type { ExecutionOutput } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { failureFactsOf, nodeNameOf } from "./failure-facts.js";
import { toolNameOf } from "./script.js";
import { ComponentScript, type ModelRequest } from "./script-book.js";

/** What `toFailWith` expects: a code (`step.router`, `limit.budget`, a budget's name, …) and/or a node. */
export interface ExpectedFailure {
  readonly code?: string;
  readonly node?: Class;
}

/** Parts of a request `toHaveBeenAskedWith` looks for; strings match as substrings. */
export interface ExpectedRequest {
  readonly kind?: ModelRequest["kind"];
  readonly system?: string;
  readonly input?: string;
  readonly instructions?: string;
  readonly options?: readonly string[];
}

/** The part of Vitest's matcher context these matchers use. */
interface MatcherContext {
  readonly isNot: boolean;
  readonly equals: (a: unknown, b: unknown) => boolean;
}

/** A matcher's verdict; `message` reads right for both `expect(…)` and `expect(…).not`. */
interface Verdict {
  readonly pass: boolean;
  readonly message: () => string;
}

const verdict = (
  context: MatcherContext,
  pass: boolean,
  expected: string,
  got: string,
): Verdict => ({
  pass,
  message: () => `expected ${context.isNot ? "not " : ""}${expected}, ${got}`,
});

const isExecutionOutput = (value: unknown): value is ExecutionOutput =>
  typeof value === "object" && value !== null && "path" in value && "threadId" in value;

const wrongReceived = (matcher: string, wanted: string): Verdict => ({
  pass: false,
  message: () => `${matcher}: expected ${wanted}`,
});
/** `critic-agent#2` → `critic-agent`: the node of a copy (#273). */
const withoutCopyNumber = (nodeId: string): string => nodeId.replace(/#\d+$/, "");

const RUN = "a run result (app.execute / app.resume)";
const SCRIPT = "mockLlm(…) of an agent or a router";

const pathText = (path: readonly string[]): string => path.join(" → ") || "(none)";

const endOf = (run: ExecutionOutput): string => {
  if (run.finish !== undefined)
    return `it finished at "${run.finish.name}" with ${JSON.stringify(run.output)}`;
  if (run.pause !== undefined) return `it paused at "${run.pause.agent}"`;
  return `it ended ${run.status} without a finish`;
};

/** A request has every expected part (strings as substrings). */
function hasParts(
  request: ModelRequest,
  expected: ExpectedRequest,
  context: MatcherContext,
): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const actual: unknown = new Map<string, unknown>(Object.entries(request)).get(key);
    if (typeof value === "string" && typeof actual === "string") return actual.includes(value);
    return context.equals(actual, value);
  });
}

/** Matchers on run results, errors and `mockLlm(…)` — all by class. Registered by the setup file. */
export const workflowMatchers = {
  /** The execution visited these components, in this order (compared by node id = `name`). */
  toFollowPath(this: MatcherContext, received: unknown, path: readonly Class[]): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toFollowPath", RUN);
    const expected = path.map(nodeNameOf);
    // a copy of a repeated agent of a launch is `critic-agent#2` in the path: its class is its node
    const pass = this.equals(received.path.map(withoutCopyNumber), expected);
    return verdict(
      this,
      pass,
      `the path ${pathText(expected)}`,
      `it was ${pathText(received.path)}`,
    );
  },

  toFinishWith(this: MatcherContext, received: unknown, finish: Class, output?: unknown): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toFinishWith", RUN);
    const pass =
      received.finish?.name === nodeNameOf(finish) &&
      (output === undefined || this.equals(received.output, output));
    const data = output === undefined ? "" : ` with ${JSON.stringify(output)}`;
    const said = `the run to finish at ${nodeNameOf(finish)}${data}`;
    return verdict(this, pass, said, endOf(received));
  },

  toHavePausedAt(this: MatcherContext, received: unknown, agent: Class): Verdict {
    if (!isExecutionOutput(received)) return wrongReceived("toHavePausedAt", RUN);
    const pass = received.pause?.agent === nodeNameOf(agent);
    return verdict(this, pass, `the run to pause at ${nodeNameOf(agent)}`, endOf(received));
  },

  toFailWith(this: MatcherContext, received: unknown, failure: ExpectedFailure): Verdict {
    const facts = failureFactsOf(received);
    const node = failure.node;
    const pass =
      received instanceof Error &&
      (failure.code === undefined || facts.codes.includes(failure.code)) &&
      (node === undefined || facts.nodes.includes(nodeNameOf(node)));
    const wanted = [failure.code, node === undefined ? undefined : `at ${nodeNameOf(node)}`];
    const got =
      received instanceof Error ? `got ${received.name}: ${received.message}` : "got no error";
    return verdict(this, pass, ["a failure", ...wanted].filter(Boolean).join(" "), got);
  },

  toHaveCalledTools(this: MatcherContext, received: unknown, tools: readonly Class[]): Verdict {
    if (!(received instanceof ComponentScript)) return wrongReceived("toHaveCalledTools", SCRIPT);
    const names = tools.map(toolNameOf);
    const pass = this.equals(received.toolCalls, names);
    const said = `${received.label} to call ${names.join(", ") || "no tools"}`;
    return verdict(this, pass, said, `it called ${received.toolCalls.join(", ") || "none"}`);
  },

  toHaveBeenAskedWith(this: MatcherContext, received: unknown, request: ExpectedRequest): Verdict {
    if (!(received instanceof ComponentScript)) return wrongReceived("toHaveBeenAskedWith", SCRIPT);
    const pass = received.requests.some((sent) => hasParts(sent, request, this));
    const asked = `${received.label} to be asked with ${JSON.stringify(request)}`;
    return verdict(this, pass, asked, `its requests: ${JSON.stringify(received.requests)}`);
  },
};

/** The matchers, typed for `expect(…)` in tests (`agboss/testing` brings this in). */
export interface WorkflowMatchers<R = unknown> {
  toFollowPath(path: readonly Class[]): R;
  toFinishWith(finish: Class, output?: unknown): R;
  toHavePausedAt(agent: Class): R;
  toFailWith(failure: ExpectedFailure): R;
  toHaveCalledTools(tools: readonly Class[]): R;
  toHaveBeenAskedWith(request: ExpectedRequest): R;
}
