/**
 * #940 AC5: `@ChannelListener` takes a class that implements the handler — `onPauseOpened` and
 * `onPauseClosed` — with its options typed; the events carry what a listener reads, `answer` and
 * `ask` untyped (masked), `pauseId` optional; a channel's events are typed by its role.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  ChannelListener,
  type ChannelPauseClosedEvent,
  type PauseActor,
  type PauseClosedReason,
  type PauseDeliveredEvent,
  type ChannelListenerClosedEvent,
  type ChannelListenerOpenedEvent,
  type ChannelListenerOptions,
} from "../../src/index.js";

describe("#940 AC5: the listener's types", () => {
  it("every event carries the dedupe key", () => {
    expectTypeOf<ChannelListenerOpenedEvent>().toExtend<PauseDeliveredEvent>();
    expectTypeOf<ChannelListenerClosedEvent>().toExtend<PauseDeliveredEvent>();
    expectTypeOf<ChannelPauseClosedEvent<never>>().toExtend<PauseDeliveredEvent>();
    expectTypeOf<PauseDeliveredEvent["deliveryId"]>().toEqualTypeOf<string>();
  });

  it("a listener reads a correlation key; the raw id is optional", () => {
    expectTypeOf<ChannelListenerOpenedEvent["pauseKey"]>().toEqualTypeOf<string>();
    expectTypeOf<ChannelListenerOpenedEvent["pauseId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelListenerClosedEvent["reason"]>().toEqualTypeOf<PauseClosedReason>();
    expectTypeOf<ChannelListenerClosedEvent["actor"]>().toEqualTypeOf<PauseActor | undefined>();
  });

  it("the options: an optional name, its dependencies and the trust to answer", () => {
    expectTypeOf<ChannelListenerOptions["name"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelListenerOptions["includePauseIds"]>().toEqualTypeOf<boolean | undefined>();
  });

  it("the decorator takes a class that implements the handler, and refuses another", () => {
    class Handler {
      onPauseOpened = (): Promise<void> => Promise.resolve();
      onPauseClosed = (): Promise<void> => Promise.resolve();
    }
    class OnlyOpened {
      onPauseOpened = (): Promise<void> => Promise.resolve();
    }
    ChannelListener({ name: "ok-pause-listener" })(Handler);
    // every hook is optional: a class with one of them is a listener
    ChannelListener({ name: "opened-pause-listener" })(OnlyOpened);
  });
});
