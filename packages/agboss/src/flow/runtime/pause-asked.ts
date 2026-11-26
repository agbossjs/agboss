import { noticesWritten, recipientsIn } from "../../pause/index.js";
import { pauseTallyOf } from "../../pause/pause-tally.js";
import type { PauseRecord } from "../../infrastructure/pause-record.js";
import type { PauseStepSite } from "./pause-open.js";

/** The pause's channel was asked and the step's own write lost: marks it sent, writing its `opened` (and a change's `reassigned`). */
export async function markAsked(site: PauseStepSite, pause: PauseRecord): Promise<void> {
  await site.pauses.markSentByTenantIdAndPauseId(
    pause.tenantId,
    pause.pauseId,
    recipientsIn(site, pause),
  );
  noticesWritten(site);
  pauseTallyOf(site)?.opened(pause);
}
