import type { Class } from "../../components/injection.js";
import type { InputMatcherOf } from "../script-types.js";
import type { RecordedInput } from "../input-match.js";

/**
 * How a test runs the branches of a parallel launch (#262 S33): `Sequential` (the default) — in
 * listed / item order, one at a time; `Real` — as in production, within `maxConcurrency`;
 * `inOrder([step(A), step(B)])` — branches start as usual, and each waits at its completion point
 * until the listed steps before it have completed: a race, a `FailFast` or a quorum reproduced on
 * every run. `testWith(App, { concurrency: TestConcurrency.inOrder([step(SkillsAgent), …]) })`.
 */

/** Which way a test schedules branches. */
export enum ConcurrencyMode {
  Sequential = "sequential",
  Real = "real",
  InOrder = "in-order",
}

/**
 * One step of `TestConcurrency.inOrder(…)`: a branch of `node` whose input matches `input` (the same
 * `PartialValues<InputOf<Node>>` matcher as `when(…)`; none = any branch of the node). It only
 * names a branch — it never supplies an input.
 */
export interface OrderedStep {
  readonly node: Class;
  readonly input?: RecordedInput;
}

/** `step(CultureScoreAgent)`, `step(CompanyCheckAgent, { company: { name: "Acme" } })`. */
export function step<TNode extends Class>(
  node: TNode,
  input?: InputMatcherOf<InstanceType<TNode>>,
): OrderedStep;
export function step(node: Class, input?: RecordedInput): OrderedStep {
  return input === undefined ? { node } : { node, input };
}

/** A test's schedule of launch branches: one of three, made by its statics. */
export class TestConcurrency {
  /** One branch at a time, in listed / item order (the default). */
  static readonly Sequential: TestConcurrency = new TestConcurrency(ConcurrencyMode.Sequential, []);
  /** The real scheduler: every branch within `maxConcurrency`, no gates. */
  static readonly Real: TestConcurrency = new TestConcurrency(ConcurrencyMode.Real, []);

  private constructor(
    readonly mode: ConcurrencyMode,
    readonly steps: readonly OrderedStep[],
  ) {}

  /**
   * Completions in this order: listed steps complete strictly in list order, unlisted branches
   * after them in item order. A step waiting at its gate is cancelled at once by a `FailFast`, a
   * decided quorum or `app.cancel`; when no branch can move and the next step is not waiting, the
   * test fails at once; a step never reached fails the test at its end.
   */
  static inOrder(steps: readonly OrderedStep[]): TestConcurrency {
    return new TestConcurrency(ConcurrencyMode.InOrder, [...steps]);
  }
}
