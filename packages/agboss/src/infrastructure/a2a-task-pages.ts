import { z } from "zod";
import { definedOf } from "./clock.js";
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
  // Stryker disable next-line StringLiteral: any text no owner's id is keys no owner the same
  `${key.tenantId}\u0000${key.ownerId ?? ""}\u0000${key.messageId}`;

/** The greatest time a `Date` holds, in ms either side of 1970. */
const MAX_TIME = 8.64e15;

/** A token's content: the status time (one a date holds, L3) and the id of the last task given. */
const PositionToken = z.tuple([z.int().min(-MAX_TIME).max(MAX_TIME), z.string()]);

/** Where a page starts: after this task in the order of `list`. */
interface PagePosition {
  readonly statusAt: number;
  readonly taskId: string;
}

/** The opaque token of the page after `task`. */
export const a2aPageTokenOf = (task: Pick<A2ATaskRecord, "statusAt" | "taskId">): string =>
  Buffer.from(JSON.stringify([task.statusAt.getTime(), task.taskId])).toString("base64url");

/** A token's JSON; `undefined` for text that is none, which the token's schema refuses. */
// Stryker disable BlockStatement: an emptied catch returns `undefined` all the same; an emptied try
// refuses every token, which every list case after its first page shows
function jsonOf(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}
// Stryker restore BlockStatement

/** Where the page of `token` starts; `InvalidA2APageTokenError` for a token no list gave. */
export function a2aPagePositionOf(token: string): PagePosition {
  const parsed = PositionToken.safeParse(jsonOf(token));
  if (!parsed.success) throw new InvalidA2APageTokenError();
  const [statusAt, taskId] = parsed.data;
  return { statusAt, taskId };
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
  // Stryker disable next-line EqualityOperator: one tenant's task ids are unique, never equal
  (left.taskId < right.taskId ? 1 : -1);

/** A page of `matching` (every task the query matches, sorted by `byNewestStatus`) as `list` gives it. */
export function a2aPageOf(matching: readonly A2ATaskRecord[], query: A2ATaskQuery): A2ATaskPage {
  const token = query.pageToken ?? "";
  const position = token === "" ? undefined : a2aPagePositionOf(token);
  const after =
    position === undefined ? matching : matching.filter((task) => isAfterPosition(task, position));
  const tasks = after.slice(0, query.pageSize);
  return {
    tasks,
    nextPageToken: nextPageTokenOf(tasks, after.length > query.pageSize),
    totalSize: matching.length,
  };
}

/** The token of the page after `tasks` when more follow, else `""` (the last page, §3.1.4). */
export const nextPageTokenOf = (tasks: readonly A2ATaskRecord[], hasMore: boolean): string =>
  hasMore ? a2aPageTokenOf(definedOf(tasks.at(-1), "a page with more after it is not empty")) : "";
