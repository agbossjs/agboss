import { z } from "zod";
import type { A2AAdapter } from "./a2a-adapter.js";
import type { Exchange } from "./a2a-exchange.js";
import { failureResponseOf } from "./a2a-mapping.js";
import { A2AStatus } from "./types.js";

const CancelSchema = z.object({ threadId: z.string().min(1) });

/**
 * `POST <base>/cancel { threadId }` (#398 PR 2): `adapter.cancel(threadId, caller)` for the
 * resolved caller — its tenant's thread only; another tenant's thread of the same id is never
 * touched. Answers `{ threadId, status: "cancelled" }`, or the failure (`code`
 * `run.unknown-thread`, `run.thread-owner`) with `status: "failed"`.
 */
export const cancelExchangeOf =
  (adapter: A2AAdapter): Exchange =>
  (body, _onEvent, options) => {
    const parsed = CancelSchema.safeParse(body);
    if (!parsed.success) return undefined;
    const { threadId } = parsed.data;
    return adapter.cancel(threadId, options).then(
      () => ({ threadId, status: A2AStatus.Cancelled }),
      (error: unknown) => ({
        ...failureResponseOf(error, undefined, threadId),
        status: A2AStatus.Failed,
      }),
    );
  };
