import type {
  BranchScheduler,
  ScheduledBranch,
} from "../../flow/runtime/launch/branch-schedule.js";
import { TestFailure } from "../errors.js";
import { inputText, matchesInput } from "../input-match.js";
import type { ScriptedExpectation } from "../script-book.js";
import type { OrderedStep } from "./test-concurrency.js";

/**
 * The completion-gate coordinator of `TestConcurrency.inOrder(…)` (#262 S33): every branch runs to
 * its completion point and waits at its gate. A gate opens only while no released branch is still
 * finishing — so the effects of one completion (a `FailFast` abort, a decided quorum) land before
 * the next — and then for the next listed step, or, once every listed step completed, for the
 * waiting branch first in item order. A waiting branch whose signal aborts leaves at once (its step
 * counts as reached, as does the step of a branch cancelled before its gate); when no branch can
 * move and the next listed step is not waiting, every waiting branch fails with the reason,
 * reported to the test.
 */

/** Where a tracked branch stands. */
enum BranchState {
  /** Its task began; it has no slot yet. */
  Queued = "queued",
  /** It runs: before its gate, or released from it. */
  Running = "running",
  /** It waits at its gate. */
  AtGate = "at-gate",
}

/** A branch waiting at its gate. */
interface Waiting {
  readonly branch: ScheduledBranch;
  /** The listed step it is (its index), or none: an unlisted branch. */
  readonly listed: number | undefined;
  readonly open: () => void;
  readonly fail: (reason: Error) => void;
}

/** How many turns of the event loop nothing may move before the order counts as stuck. */
const STUCK_TURNS = 3;

const keyOf = (branch: ScheduledBranch): string => `${branch.launchId}#${String(branch.index)}`;

const stepText = (step: OrderedStep): string =>
  step.input === undefined
    ? `step(${step.node.name})`
    : `step(${step.node.name}, ${inputText(step.input)})`;

const branchText = (waiting: Waiting): string =>
  `${waiting.branch.nodeId} ${inputText(waiting.branch.input())}`;

/** Item order across launches: the launch first, then the ticket's index. */
const byItemOrder = (left: Waiting, right: Waiting): number =>
  left.branch.launchId === right.branch.launchId
    ? left.branch.index - right.branch.index
    : left.branch.launchId < right.branch.launchId
      ? -1
      : 1;

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export class CompletionGates implements BranchScheduler, ScriptedExpectation {
  readonly #states = new Map<string, BranchState>();
  readonly #waiting: Waiting[] = [];
  /** The branches that took their step (reached their gate, or ended before it). */
  readonly #placed = new Set<string>();
  /** Each listed step: taken by a branch. */
  readonly #taken: boolean[];
  /** Each listed step: completed (released, or cancelled). */
  readonly #done: boolean[];
  /** The released branch still finishing: no gate opens until it ends. */
  #finishing: string | undefined;
  /** Bumped on every move: a stuck check holds only while it does not change. */
  #moves = 0;

  constructor(
    private readonly steps: readonly OrderedStep[],
    private readonly report: (failure: Error) => void,
  ) {
    this.#taken = steps.map(() => false);
    this.#done = steps.map(() => false);
  }

  slotsOf(declared: number): number {
    return declared;
  }

  entered(branch: ScheduledBranch): void {
    this.#set(branch, BranchState.Queued);
  }

  started(branch: ScheduledBranch): void {
    this.#set(branch, BranchState.Running);
  }

  completed(branch: ScheduledBranch, signal: AbortSignal): Promise<void> {
    const listed = this.#place(branch);
    if (signal.aborted) {
      this.#complete(listed);
      return Promise.reject(signal.reason as Error);
    }
    return new Promise<void>((resolve, reject) => {
      const leave = (): void => {
        this.#waiting.splice(this.#waiting.indexOf(waiting), 1);
        this.#complete(listed);
        this.#set(branch, BranchState.Running);
        reject(signal.reason as Error);
        this.#openNext();
      };
      const waiting: Waiting = {
        branch,
        listed,
        open: () => {
          signal.removeEventListener("abort", leave);
          resolve();
        },
        fail: (reason) => {
          signal.removeEventListener("abort", leave);
          reject(reason);
        },
      };
      signal.addEventListener("abort", leave, { once: true });
      this.#waiting.push(waiting);
      this.#set(branch, BranchState.AtGate);
      this.#openNext();
    });
  }

  ended(branch: ScheduledBranch): void {
    const key = keyOf(branch);
    // a branch cancelled before its gate (no slot, or aborted while running) reached its step too
    if (!this.#placed.has(key)) this.#complete(this.#place(branch));
    this.#states.delete(key);
    this.#moves += 1;
    if (this.#finishing === key) this.#finishing = undefined;
    this.#openNext();
  }

  leftovers(): readonly string[] {
    return this.steps.flatMap((step, index) =>
      this.#done[index] === true
        ? []
        : [`TestConcurrency.inOrder: ${stepText(step)} was never reached`],
    );
  }

  #set(branch: ScheduledBranch, state: BranchState): void {
    this.#states.set(keyOf(branch), state);
    this.#moves += 1;
  }

  /** The first listed step not taken yet that the branch is (its node, its input). */
  #place(branch: ScheduledBranch): number | undefined {
    this.#placed.add(keyOf(branch));
    const index = this.steps.findIndex(
      (step, at) =>
        this.#taken[at] !== true &&
        step.node === branch.component &&
        (step.input === undefined || matchesInput(branch.input(), step.input)),
    );
    if (index === -1) return undefined;
    this.#taken[index] = true;
    return index;
  }

  #complete(listed: number | undefined): void {
    if (listed !== undefined) this.#done[listed] = true;
  }

  /** The next listed step's index; `steps.length` once all are done. */
  #nextStep(): number {
    const index = this.#done.findIndex((done) => !done);
    return index === -1 ? this.steps.length : index;
  }

  #openNext(): void {
    if (this.#finishing !== undefined) return;
    const next = this.#nextStep();
    const candidate =
      next < this.steps.length
        ? this.#waiting.find((waiting) => waiting.listed === next)
        : [...this.#waiting].sort(byItemOrder)[0];
    if (candidate === undefined) {
      if (this.#isStuck()) void this.#confirmStuck(this.#moves);
      return;
    }
    this.#waiting.splice(this.#waiting.indexOf(candidate), 1);
    this.#complete(candidate.listed);
    this.#set(candidate.branch, BranchState.Running);
    this.#finishing = keyOf(candidate.branch);
    candidate.open();
  }

  /** Branches wait at their gates, none runs, and the next listed step is not among them. */
  #isStuck(): boolean {
    const isMoving = [...this.#states.values()].includes(BranchState.Running);
    return !isMoving && this.#finishing === undefined && this.#waiting.length > 0;
  }

  /** Stuck for a few turns of the event loop with nothing moving: the test fails. */
  async #confirmStuck(moves: number): Promise<void> {
    for (let turn = 0; turn < STUCK_TURNS; turn += 1) {
      await nextTurn();
      if (this.#moves !== moves || !this.#isStuck()) return;
    }
    const step = this.steps[this.#nextStep()];
    const waiting = this.#waiting.map(branchText).join(", ");
    const next = step === undefined ? "the next branch" : `the next step ${stepText(step)}`;
    const failure = new TestFailure(
      "test.unreachable-step",
      `TestConcurrency.inOrder: ${next} cannot complete — no branch runs and it is not waiting at its gate (waiting: ${waiting}; a branch without a slot waits for one: maxConcurrency)`,
    );
    this.report(failure);
    this.#done.fill(true);
    for (const stuck of this.#waiting.splice(0)) stuck.fail(failure);
  }
}
