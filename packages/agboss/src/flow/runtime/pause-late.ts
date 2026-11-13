import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../infrastructure/pause-record.js";
import type { PauseWithdrawn } from "../../pause/index.js";
import type { FrameSpec } from "../context/frame.js";

/**
 * A pause its channel sent that closed while `send` was still returning (#337): whoever closed it
 * saw it unsent, so its own step tells the channel, in its own frame.
 */
export async function sentTooLate(
  site: { readonly withdrawn?: PauseWithdrawn | undefined; readonly frame: FrameSpec },
  pause: PauseRecord,
): Promise<void> {
  const { resolution } = pause;
  const isWithdrawn =
    resolution === PauseResolution.Withdrawn || resolution === PauseResolution.Cancelled;
  if (pause.status === PauseStatus.Cancelled && isWithdrawn && site.withdrawn !== undefined)
    await site.withdrawn({ pause, resolution, frame: site.frame });
}
