/**
 * The checkpoint threads of one execution tree (#1321d). A child execution runs on its own thread,
 * `<parentThreadId>/child/<executionId>` (ADR-0022), at any depth; the root's thread is its
 * execution id. Removing a tree's checkpoints (`deleteThread(rootExecutionId)`) removes all of them
 * and only them: a thread whose id merely starts with the root's (`<id>x`, `<id>0/child/…`) is another tree's.
 */

/** What joins a parent's thread id to a child's execution id. */
export const CHILD_THREAD_SEPARATOR = "/child/";

/** The child thread `<parentThreadId>/child/<executionId>`. */
export const childThreadOf = (parentThreadId: string, executionId: string): string =>
  `${parentThreadId}${CHILD_THREAD_SEPARATOR}${executionId}`;

/** Whether `candidate` is a child thread of `threadId`, at any depth. */
export const isChildThreadOf = (threadId: string, candidate: string): boolean =>
  candidate.startsWith(`${threadId}${CHILD_THREAD_SEPARATOR}`);

/**
 * The half-open range of the thread ids below `threadId` for a store that deletes by comparison
 * (`thread_id >= lower AND thread_id < upper`, in code-point order — PostgreSQL `COLLATE "C"`,
 * SQLite's default): `/child/` and `/child0` differ in their last character, `/` then `0`.
 */
export const childThreadRangeOf = (
  threadId: string,
): { readonly lower: string; readonly upper: string } => ({
  lower: `${threadId}${CHILD_THREAD_SEPARATOR}`,
  upper: `${threadId}/child0`,
});
