import {
  InvalidA2APageTokenError,
  type A2AMessageKey,
  type A2ATaskKey,
  type A2ATaskPage,
  type A2ATaskQuery,
  type A2ATaskRecord,
} from "./a2a-task.repository.js";

/** The keys and pages of the A2A task stores (#807): rows, the order of `list`, page tokens. */

/** The row key of a task (`\u0000` never occurs in a key's text). */
export const a2aTaskRowOf = (key: A2ATaskKey): string => `${key.tenantId}\u0000${key.taskId}`;

/** The row key of a message: no owner is the empty text, which no owner's id is (#589). */
export const a2aMessageRowOf = (key: A2AMessageKey): string =>
  `${key.tenantId}\u0000${key.ownerId ?? ""}\u0000${key.messageId}`;

/** Where a page starts: after this task in the order of `list`. */
interface PagePosition {
  readonly statusAt: number;
  readonly taskId: string;
}

/** The opaque token of the page after `task`. */
export const a2aPageTokenOf = (task: Pick<A2ATaskRecord, "statusAt" | "taskId">): string =>
  Buffer.from(JSON.stringify([task.statusAt.getTime(), task.taskId])).toString("base64url");

/** Where the page of `token` starts; `InvalidA2APageTokenError` for a token no list gave. */
export function a2aPagePositionOf(token: string): PagePosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new InvalidA2APageTokenError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new InvalidA2APageTokenError();
  const [statusAt, taskId] = parsed as readonly unknown[];
  if (!Number.isSafeInteger(statusAt) || typeof taskId !== "string")
    throw new InvalidA2APageTokenError();
  return { statusAt: statusAt as number, taskId };
}

/** Whether `task` comes after `position` in the order of `list` (status time, then id, both down). */
export const isAfterPosition = (
  task: Pick<A2ATaskRecord, "statusAt" | "taskId">,
  position: PagePosition,
): boolean => {
  const at = task.statusAt.getTime();
  return at < position.statusAt || (at === position.statusAt && task.taskId < position.taskId);
};

/** The order of `list`: the newest status first, then the greater id. */
export const byNewestStatus = (
  left: Pick<A2ATaskRecord, "statusAt" | "taskId">,
  right: Pick<A2ATaskRecord, "statusAt" | "taskId">,
): number =>
  right.statusAt.getTime() - left.statusAt.getTime() ||
  (left.taskId < right.taskId ? 1 : left.taskId > right.taskId ? -1 : 0);

/** A page of `matching` (sorted by `byNewestStatus`) as `list` gives it. */
export function a2aPageOf(matching: readonly A2ATaskRecord[], query: A2ATaskQuery): A2ATaskPage {
  const token = query.pageToken ?? "";
  const position = token === "" ? undefined : a2aPagePositionOf(token);
  const after =
    position === undefined ? matching : matching.filter((task) => isAfterPosition(task, position));
  const tasks = after.slice(0, query.pageSize);
  const last = tasks.at(-1);
  const isLast = last === undefined || after.length <= query.pageSize;
  return { tasks, nextPageToken: isLast ? "" : a2aPageTokenOf(last) };
}
