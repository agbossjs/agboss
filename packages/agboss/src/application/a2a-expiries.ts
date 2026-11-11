import { a2aFileExpiryOf } from "../infrastructure/a2a-file.repository.js";
import { a2aTaskExpiryOf } from "../infrastructure/a2a-task.repository.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { Expiry } from "../infrastructure/expiry.js";
import type { Milliseconds } from "../units/index.js";
import { lazyLoad } from "../infrastructure/clock.js";

/** How long the A2A rows are kept once their task is over (`retention.a2aTasks`, `.a2aFiles`). */
export interface A2ARetentions {
  readonly a2aTaskRetention: Milliseconds;
  readonly a2aFileRetention: Milliseconds;
  /** How long a direct message's reply is kept (`retention.a2aMessages`, #860). */
  readonly a2aMessageRetention: Milliseconds;
}

/** The sweep of the direct messages (#860), loaded on its first look. */
const directMessageExpiry = () =>
  lazyLoad(import("../infrastructure/a2a-direct-message-expiry.js"));

/**
 * What the recovery sweep removes of the A2A rows: the finished tasks (#807), their files (#859),
 * the direct messages' replies and their lost attempts' files (#860).
 */
export const a2aExpiriesOf = (
  infrastructure: Pick<Infrastructure, "a2aTasks" | "a2aFiles" | "a2aDirectMessages" | "clock">,
  retentions: A2ARetentions,
): readonly Expiry[] => [
  a2aTaskExpiryOf(infrastructure.a2aTasks, retentions.a2aTaskRetention),
  a2aFileExpiryOf({
    files: infrastructure.a2aFiles,
    tasks: infrastructure.a2aTasks,
    clock: infrastructure.clock,
    retention: retentions.a2aFileRetention,
  }),
  {
    what: "the direct A2A messages",
    remove: async (cutoff) => {
      const { a2aDirectMessageExpiryOf } = await directMessageExpiry();
      const sources = {
        messages: infrastructure.a2aDirectMessages,
        files: infrastructure.a2aFiles,
        clock: infrastructure.clock,
        retention: retentions.a2aMessageRetention,
      };
      await a2aDirectMessageExpiryOf(sources).remove?.(cutoff);
    },
    retention: retentions.a2aMessageRetention,
  },
];
