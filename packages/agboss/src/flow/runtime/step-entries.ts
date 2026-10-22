import { AsyncLocalStorage } from "node:async_hooks";
import { currentFrame, rootFactsOf, type FrameSpec } from "../context/frame.js";
import type { ExecutionTree } from "../../infrastructure/execution-tree.repository.js";

/**
 * The running step bodies of an application instance (#367), in process and per tree: an agent's,
 * a router's or an action's visit, a branch of a launch, a tool call. An entry opens when the body
 * starts and closes when the body's own promise settles — not when LangGraph stops waiting for it:
 * after an abort, `invoke` / `stream` reject before the running tasks return (#340 S2), so a pass
 * can end while a body that ignores its signal still runs. Whoever must not go on while a body
 * runs awaits the tree's entries with its own bound: the graceful stop before `onDestroy` and a
 * lease release (#367), the automatic unwind before it undoes (#340 PR 2, `compensationTimeout`).
 */

/** One running step body: its tree, its execution and the step — ids only, never a value. */
export interface StepEntry {
  readonly tenantId: string;
  readonly rootExecutionId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly visitNumber: number;
  /** The item of a per-item branch (#273); `undefined` otherwise. */
  readonly itemIndex?: number | undefined;
  /** The tool call's id (a tool call's body); `undefined` for a node's visit. */
  readonly callId?: string | undefined;
}

/** An open entry and how its close is awaited. */
interface OpenEntry {
  readonly entry: StepEntry;
  readonly closed: Promise<void>;
}

const keyOf = (tree: ExecutionTree): string => `${tree.tenantId}\u0000${tree.rootExecutionId}`;

/** The entry of the body that runs in `frame`'s step (or tool call). */
function entryOf(frame: FrameSpec): StepEntry {
  const { execution, step } = frame;
  return {
    tenantId: execution.tenant.tenantId,
    rootExecutionId: rootFactsOf(execution).executionId,
    executionId: execution.executionId,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    itemIndex: step.itemIndex,
    callId: step.callId,
  };
}

/** Resolves when `signal` aborts (at once when it already did). */
const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });

export class StepEntries {
  readonly #trees = new Map<string, Set<OpenEntry>>();

  /**
   * Runs the body `work` of the step in `frame` as an open entry of its tree, closed when the
   * body's promise settles (also when it throws); the result is the body's, as it is.
   */
  track<TResult>(frame: FrameSpec, work: () => Promise<TResult>): Promise<TResult> {
    const entry = entryOf(frame);
    const key = keyOf(entry);
    const body = work();
    const open: OpenEntry = {
      entry,
      closed: body.then(
        () => undefined,
        () => undefined,
      ),
    };
    const tree = this.#trees.get(key) ?? new Set<OpenEntry>();
    tree.add(open);
    this.#trees.set(key, tree);
    void open.closed.then(() => {
      tree.delete(open);
      if (tree.size === 0 && this.#trees.get(key) === tree) this.#trees.delete(key);
    });
    return body;
  }

  /** The tree's running bodies now. */
  openOf(tree: ExecutionTree): readonly StepEntry[] {
    return [...(this.#trees.get(keyOf(tree)) ?? [])].map((open) => open.entry);
  }

  /** Every running body of the instance now. */
  open(): readonly StepEntry[] {
    return [...this.#trees.values()].flatMap((tree) => [...tree].map((open) => open.entry));
  }

  /**
   * Resolves when every body of the tree has returned — the ones opened meanwhile too — or when
   * `until` aborts (the caller's bound), with the bodies still running then (`[]`: all returned).
   */
  closedOf(tree: ExecutionTree, until: AbortSignal): Promise<readonly StepEntry[]> {
    return this.#closed(() => [...(this.#trees.get(keyOf(tree)) ?? [])], until);
  }

  /**
   * `closedOf` for the tree's bodies `matches` keeps: a failed join's unwind awaits only its own
   * launch's branches (#340 Q-A), never its tree's other work.
   */
  closedWhere(
    tree: ExecutionTree,
    matches: (entry: StepEntry) => boolean,
    until: AbortSignal,
  ): Promise<readonly StepEntry[]> {
    const openNow = (): readonly OpenEntry[] =>
      [...(this.#trees.get(keyOf(tree)) ?? [])].filter((open) => matches(open.entry));
    return this.#closed(openNow, until);
  }

  /** `closedOf` for every tree of the instance (its graceful stop before `onDestroy`). */
  allClosed(until: AbortSignal): Promise<readonly StepEntry[]> {
    return this.#closed(() => [...this.#trees.values()].flatMap((tree) => [...tree]), until);
  }

  async #closed(
    openNow: () => readonly OpenEntry[],
    until: AbortSignal,
  ): Promise<readonly StepEntry[]> {
    const bound = abortOf(until);
    for (let open = openNow(); open.length > 0; open = openNow()) {
      if (until.aborted) return open.map((each) => each.entry);
      await Promise.race([Promise.all(open.map((each) => each.closed)), bound]);
    }
    return [];
  }
}

/** The registry of the step whose body runs now: a tool call inside it opens its entry there. */
const current = new AsyncLocalStorage<StepEntries>();

/**
 * Runs a step's body — the step in `frame` — as an entry of `steps`, and inside it every tool call
 * as one of its own; without a registry (outside an application), as it is.
 */
export function inStepEntry<TResult>(
  steps: StepEntries | undefined,
  frame: FrameSpec,
  work: () => Promise<TResult>,
): Promise<TResult> {
  return steps === undefined ? work() : steps.track(frame, () => current.run(steps, work));
}

/** Runs a body of the current frame (a tool call's) as an entry of its step's registry, if any. */
export function inCurrentStepEntry<TResult>(work: () => Promise<TResult>): Promise<TResult> {
  const frame = currentFrame();
  const steps = current.getStore();
  return frame === undefined || frame.isClosed() || steps === undefined
    ? work()
    : steps.track(frame, work);
}
