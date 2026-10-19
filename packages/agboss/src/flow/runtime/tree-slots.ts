import type { RunnableConfig } from "@langchain/core/runnables";
import { ExecutionCancelledError } from "../../core/errors.js";
import { extractRunContext } from "../../core/run-context.js";
import type { Clock } from "../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { NodeKind } from "../ast.js";
import { executionsFromRootOf, type ExecutionFacts } from "../context/frame.js";
import {
  declaredMaxConcurrentExecutionsOf,
  maxConcurrentExecutionsOf,
} from "../decorators/workflow.js";
import type { RuntimeGraph, RuntimeNode } from "./graph-model.js";
import type { TreeSlotRegistry } from "./launch/launch-registry.js";
import type { ExecutionStateType } from "./state.js";

/**
 * The tree's concurrency cap (#264 S27): `@Workflow({ maxConcurrentExecutions })` of the root — how
 * many executions of one tree (the root and all its descendants) work at once. A priority semaphore
 * per tree, in-process: only the tree's lease holder moves it (Q58) and its children are subgraphs
 * of its checkpoint (#263 S24), so its slots never leave this process — no storage contract.
 *
 * A slot is an execution, not a step: an execution holds one while at least one of its steps runs
 * (parallel branches of one execution share it) and gives it back when its last running step ends,
 * pauses or fails — so an execution waiting at a join or for its child holds none, and the tree
 * cannot deadlock. A step without a free slot waits in the queue (a throttle, never an error) in
 * this order: a parent whose children have all finished (it closes a branch), then the deepest
 * execution; every `AGING_STEP` of waiting counts as one level deeper, read from the application's
 * `Clock` when a slot frees. A child workflow's own, smaller `maxConcurrentExecutions` caps its
 * subtree inside the tree's. A waiter whose signal aborts (a cancel, a `FailFast` launch) leaves the
 * queue. After a pause or a crash the next pass makes the tree's slots anew: the unfinished tasks
 * claim them again (a resume elsewhere starts with no slot held).
 */

/** Every 10 s of waiting counts as one level deeper: a framework constant, not a setting. */
export const AGING_STEP: Milliseconds = seconds(10);

/** An execution of the tree whose workflow caps its subtree below the caps around it. */
export interface SubtreeCap {
  readonly executionId: string;
  readonly maxConcurrentExecutions: number;
}

/** A step's claim on its tree's slots: its execution and that execution's place in the queue. */
export interface SlotClaim {
  readonly executionId: string;
  /** The execution's depth in its tree, from 1 at the root. */
  readonly depth: number;
  /** Its children have all finished: the step closes a branch of the tree. */
  readonly closesBranch: boolean;
  /** The capped subtrees it is in, outermost first. */
  readonly subtrees: readonly SubtreeCap[];
}

/** Told when a claim starts and stops waiting: a quorum's deadline excludes that time (#279). */
export interface QueueWatch {
  enter(): void;
  leave(): void;
}

/** A slot taken for one step: released once, when the step ends. */
export interface SlotHold {
  release(): void;
}

interface Waiter {
  readonly claim: SlotClaim;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly grant: () => void;
}

/** An execution at work: its running steps and the capped subtrees it counts in. */
interface Working {
  steps: number;
  readonly subtrees: readonly string[];
}

/** The tree's slots: a priority semaphore of `maxConcurrentExecutions` executions. */
export class TreeSlots {
  readonly #working = new Map<string, Working>();
  readonly #subtreeWork = new Map<string, number>();
  readonly #waiting: Waiter[] = [];
  #sequence = 0;

  constructor(
    readonly maxConcurrentExecutions: number,
    private readonly clock: Clock,
  ) {}

  /** The executions at work now. */
  get workingCount(): number {
    return this.#working.size;
  }

  /** The steps waiting for a slot now. */
  get waitingCount(): number {
    return this.#waiting.length;
  }

  /** Takes a slot for one step of `claim`'s execution; `undefined` when `signal` aborts first. */
  take(claim: SlotClaim, signal: AbortSignal, watch?: QueueWatch): Promise<SlotHold | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.#canWork(claim)) return Promise.resolve(this.#hold(claim));
    return new Promise<SlotHold | undefined>((resolve) => {
      const leave = (): void => {
        this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
        watch?.leave();
        resolve(undefined);
      };
      const waiter: Waiter = {
        claim,
        enqueuedAt: this.clock.now().getTime(),
        sequence: (this.#sequence += 1),
        grant: (): void => {
          signal.removeEventListener("abort", leave);
          watch?.leave();
          resolve(this.#hold(claim));
        },
      };
      this.#waiting.push(waiter);
      watch?.enter();
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  #canWork(claim: SlotClaim): boolean {
    if (this.#working.has(claim.executionId)) return true;
    if (this.#working.size >= this.maxConcurrentExecutions) return false;
    return claim.subtrees.every(
      (subtree) =>
        (this.#subtreeWork.get(subtree.executionId) ?? 0) < subtree.maxConcurrentExecutions,
    );
  }

  #hold(claim: SlotClaim): SlotHold {
    const { executionId } = claim;
    const found = this.#working.get(executionId);
    if (found !== undefined) found.steps += 1;
    else {
      const subtrees = claim.subtrees.map((subtree) => subtree.executionId);
      this.#working.set(executionId, { steps: 1, subtrees });
      for (const id of subtrees) this.#subtreeWork.set(id, (this.#subtreeWork.get(id) ?? 0) + 1);
    }
    let isReleased = false;
    return {
      release: (): void => {
        if (isReleased) return;
        isReleased = true;
        this.#release(executionId);
      },
    };
  }

  #release(executionId: string): void {
    const working = this.#working.get(executionId);
    if (working === undefined) return;
    working.steps -= 1;
    if (working.steps > 0) return;
    this.#working.delete(executionId);
    for (const id of working.subtrees)
      this.#subtreeWork.set(id, (this.#subtreeWork.get(id) ?? 1) - 1);
    this.#grantWaiting();
  }

  /** Grants the waiting claims that may work now, best first (a granted execution's other steps too). */
  #grantWaiting(): void {
    for (let next = this.#next(); next !== undefined; next = this.#next()) {
      this.#waiting.splice(this.#waiting.indexOf(next), 1);
      next.grant();
    }
  }

  #next(): Waiter | undefined {
    const now = this.clock.now().getTime();
    const ready = this.#waiting.filter((waiter) => this.#canWork(waiter.claim));
    return ready.sort((first, second) => compareWaiters(first, second, now))[0];
  }
}

/** A waiter's level in the queue: its depth, one deeper per `AGING_STEP` waited. */
const levelOf = (waiter: Waiter, now: number): number =>
  waiter.claim.depth + Math.floor((now - waiter.enqueuedAt) / AGING_STEP);

/** Queue order: a branch closing first, then the deepest (aged) level, then the first come. */
function compareWaiters(first: Waiter, second: Waiter, now: number): number {
  const closing = Number(second.claim.closesBranch) - Number(first.claim.closesBranch);
  if (closing !== 0) return closing;
  const level = levelOf(second, now) - levelOf(first, now);
  return level !== 0 ? level : first.sequence - second.sequence;
}

/**
 * A step's claim on its tree's slots (#264 S27): a step that works — an agent, a router, an action,
 * a branch of a launch too — of any execution of the tree takes one; a start and a finish only mark
 * where an execution begins and ends, and a child workflow's node waits for its child (the child's
 * own steps take theirs). The claim names the execution, its depth, whether it closes a branch (its
 * step comes right after its child, or its children's join) and the subtrees whose own, smaller cap
 * it counts in.
 */

/** Whether a visit of the node works in a slot of its tree. */
const takesSlot = (node: RuntimeNode): boolean =>
  node.kind === NodeKind.Agent || node.kind === NodeKind.Router || node.kind === NodeKind.Action;

/** The subtrees below the root whose own cap is smaller than every cap around them. */
function subtreesOf(line: readonly ExecutionFacts[], treeCap: number): readonly SubtreeCap[] {
  const subtrees: SubtreeCap[] = [];
  let enclosing = treeCap;
  for (const member of line.slice(1)) {
    const own = declaredMaxConcurrentExecutionsOf(member.workflow.type);
    if (own === undefined || own >= enclosing) continue;
    subtrees.push({ executionId: member.executionId, maxConcurrentExecutions: own });
    enclosing = own;
  }
  return subtrees;
}

/** Whether the step comes right after its execution's child, or its children's join. */
function closesBranch(graph: RuntimeGraph, state: ExecutionStateType): boolean {
  const previous = state.path.at(-1);
  return previous !== undefined && graph.nodes.get(previous)?.kind === NodeKind.Workflow;
}

/** Where a step takes its tree slot. */
export interface TreeSlotSite {
  readonly slots: TreeSlotRegistry | undefined;
  readonly graph: RuntimeGraph;
  readonly node: RuntimeNode;
  readonly state: ExecutionStateType;
  readonly config: RunnableConfig | undefined;
  /** The step's execution: its frame's. */
  readonly execution: ExecutionFacts;
  /** A quorum's deadline, told when the step waits (#279). */
  readonly watch?: QueueWatch;
}

/** A step's claim, the root of its tree and the tree's cap. */
interface TreeClaim {
  readonly root: ExecutionFacts;
  readonly cap: number;
  readonly claim: SlotClaim;
}

/** The step's claim and the tree it is on. */
function claimAt(site: TreeSlotSite): TreeClaim {
  const line = executionsFromRootOf(site.execution);
  const root = line[0] ?? site.execution;
  const cap = maxConcurrentExecutionsOf(root.workflow.type);
  const claim: SlotClaim = {
    executionId: site.execution.executionId,
    depth: line.length,
    closesBranch: closesBranch(site.graph, site.state),
    subtrees: subtreesOf(line, cap),
  };
  return { root, cap, claim };
}

/**
 * Runs one step's `work` in a slot of its tree: waits in the queue while the tree is at its cap,
 * releases the slot when the work ends, fails or pauses. A wait the execution's signal ends (a
 * cancel, its launch's `FailFast` abort) throws `ExecutionCancelledError`, the work never run.
 */
export async function inTreeSlot<TResult>(
  site: TreeSlotSite,
  work: () => Promise<TResult>,
): Promise<TResult> {
  if (site.slots === undefined || !takesSlot(site.node)) return work();
  const { root, cap, claim } = claimAt(site);
  const { clock } = extractRunContext(site.config, site.state.runId);
  const tree = site.slots.slotsOf(root.executionId, cap, clock);
  const hold = await tree.take(claim, site.execution.signal, site.watch);
  if (hold === undefined)
    throw new ExecutionCancelledError("the execution was cancelled waiting for a tree slot");
  try {
    return await work();
  } finally {
    hold.release();
  }
}
