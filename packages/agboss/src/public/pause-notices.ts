// The pause notices a channel and a listener are told (#940, #942): the listener decorator and every event.
export {
  PauseListener,
  type PauseListenerHandler,
  type PauseListenerOptions,
} from "../pause/pause-listener.js";
export type {
  ChannelPauseAnswerNotTakenEvent,
  ChannelPauseClosedEvent,
  ChannelPauseExpiringEvent,
  ChannelPauseExtendedEvent,
  PauseDeliveredEvent,
  PauseListenerAnswerNotTakenEvent,
  PauseListenerClosedEvent,
  PauseListenerEventBase,
  PauseListenerExpiringEvent,
  PauseListenerExtendedEvent,
  PauseListenerOpenedEvent,
} from "../pause/notice-events.js";
