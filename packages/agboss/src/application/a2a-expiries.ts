import { a2aFileExpiryOf } from "../infrastructure/a2a-file.repository.js";
import { a2aTaskExpiryOf } from "../infrastructure/a2a-task.repository.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { Expiry } from "../infrastructure/expiry.js";
import type { Milliseconds } from "../units/index.js";

/** How long the A2A rows are kept once their task is over (`retention.a2aTasks`, `.a2aFiles`). */
export interface A2ARetentions {
  readonly a2aTaskRetention: Milliseconds;
  readonly a2aFileRetention: Milliseconds;
}

/** What the recovery sweep removes of the A2A rows: the finished tasks (#807), their files (#859). */
export const a2aExpiriesOf = (
  infrastructure: Pick<Infrastructure, "a2aTasks" | "a2aFiles" | "clock">,
  retentions: A2ARetentions,
): readonly Expiry[] => [
  a2aTaskExpiryOf(infrastructure.a2aTasks, retentions.a2aTaskRetention),
  a2aFileExpiryOf({
    files: infrastructure.a2aFiles,
    tasks: infrastructure.a2aTasks,
    clock: infrastructure.clock,
    retention: retentions.a2aFileRetention,
  }),
];
