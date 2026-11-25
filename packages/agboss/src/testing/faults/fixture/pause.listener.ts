import {
  ChannelListener,
  type ChannelListenerClosedEvent,
  type ChannelListenerOpenedEvent,
  type ChannelListenerReassignedEvent,
} from "../../../index.js";
import { FaultPodLink } from "./pod-link.js";

/**
 * The fault fixture's pause listener (#940): a webhook fake that tells the test every notice it is
 * delivered — which pause (by its correlation key), which notice and under which `deliveryId` —
 * the moment its hook runs, before it returns: a pod killed after that has delivered (the ack
 * is not written yet), a pod killed before it has not. The invariant `notices-once-each-in-order`
 * reads these events.
 */
@ChannelListener({
  name: "fault-pause-listener",
  description: "Records every pause notice it is delivered",
  deps: [FaultPodLink],
})
export class FaultPauseListener {
  constructor(private readonly faultPodLink: FaultPodLink) {}

  onPauseOpened(event: ChannelListenerOpenedEvent): Promise<void> {
    this.faultPodLink.emit("pause-notice", {
      notice: "opened",
      pauseKey: event.pauseKey,
      deliveryId: event.deliveryId,
    });
    return Promise.resolve();
  }

  /** The one notice a listener hears of a reassignment (#1307d): it stands for the replacement's `opened`. */
  onPauseReassigned(event: ChannelListenerReassignedEvent): Promise<void> {
    this.faultPodLink.emit("pause-notice", {
      notice: "reassigned",
      pauseKey: event.pauseKey,
      deliveryId: event.deliveryId,
    });
    return Promise.resolve();
  }

  onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    this.faultPodLink.emit("pause-notice", {
      notice: "closed",
      pauseKey: event.pauseKey,
      deliveryId: event.deliveryId,
      reason: event.reason,
    });
    return Promise.resolve();
  }
}
