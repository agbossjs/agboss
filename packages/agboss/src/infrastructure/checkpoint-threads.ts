import { CHILD_THREAD_SEPARATOR } from "../core/child-thread-separator.js";

/**
 * The checkpoint threads of one execution tree (#1321d). A child execution runs on its own thread,
 * `<parentThreadId>/child/<executionId>` (ADR-0022), at any depth; the root's thread is its
 * execution id. Removing a tree's checkpoints (`deleteThread(rootExecutionId)`) removes the threads
 * whose stored root is that id and no other: a thread whose id merely starts with the root's
 * (`<id>x`, `<id>0/child/…`) is another tree's.
 */

export { CHILD_THREAD_SEPARATOR };

/**
 * The configurable key that names a checkpoint thread's tree: the root execution id, written with
 * every checkpoint and every pending write of the tree's threads. A saver deletes a tree by it
 * (`deleteThread(rootExecutionId)`), never by a range of thread ids (#1321d).
 */
export const ROOT_EXECUTION_ID_KEY = "root_execution_id";

/**
 * The root execution id a checkpoint's config names: `configurable.root_execution_id`, else the
 * thread id's first segment (an id never holds the separator, `KeyTextRule.ReservedSeparator`).
 */
export function rootExecutionIdOf(
  configurable: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const named: unknown = configurable?.[ROOT_EXECUTION_ID_KEY];
  if (typeof named === "string" && named !== "") return named;
  const thread: unknown = configurable?.thread_id;
  if (typeof thread !== "string") return undefined;
  const [first = ""] = thread.split(CHILD_THREAD_SEPARATOR, 1);
  return first === "" ? thread : first;
}

/** The child thread `<parentThreadId>/child/<executionId>`. */
export const childThreadOf = (parentThreadId: string, executionId: string): string =>
  `${parentThreadId}${CHILD_THREAD_SEPARATOR}${executionId}`;
