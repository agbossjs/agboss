/**
 * #940 AC5: `@PauseListener` takes a class that implements the handler — `onPauseOpened` and
 * `onPauseClosed` — with its options typed; the events carry what a listener reads, `answer` and
 * `ask` untyped (masked), `pauseId` optional; a channel's events are typed by its role.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  PauseListener,
  type ChannelPauseClosedEvent,
  type PauseClosedReason,
  type PauseDeliveredEvent,
  type PauseListenerClosedEvent,
  type PauseListenerHandler,
  type PauseListenerOpenedEvent,
  type PauseListenerOptions,
} from "../../src/index.js";

describe("#940 AC5: the listener's types", () => {
  it("every event carries the dedupe key", () => {
    expectTypeOf<PauseListenerOpenedEvent>().toExtend<PauseDeliveredEvent>();
    expectTypeOf<PauseListenerClosedEvent>().toExtend<PauseDeliveredEvent>();
    expectTypeOf<ChannelPauseClosedEvent<never>>().toExtend<PauseDeliveredEvent>();
    expectTypeOf<PauseDeliveredEvent["deliveryId"]>().toEqualTypeOf<string>();
  });

  it("a listener reads a correlation key; the raw id is optional", () => {
    expectTypeOf<PauseListenerOpenedEvent["pauseKey"]>().toEqualTypeOf<string>();
    expectTypeOf<PauseListenerOpenedEvent["pauseId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PauseListenerClosedEvent["reason"]>().toEqualTypeOf<PauseClosedReason>();
    expectTypeOf<PauseListenerClosedEvent["answeredBy"]>().toEqualTypeOf<string | undefined>();
  });

  it("the options: a name, its dependencies and the trust to answer", () => {
    expectTypeOf<PauseListenerOptions["name"]>().toEqualTypeOf<string>();
    expectTypeOf<PauseListenerOptions["allowAnswering"]>().toEqualTypeOf<boolean | undefined>();
  });

  it("the decorator takes a class that implements the handler, and refuses another", () => {
    class Handler implements PauseListenerHandler {
      onPauseOpened = (): Promise<void> => Promise.resolve();
      onPauseClosed = (): Promise<void> => Promise.resolve();
    }
    class NotAHandler {
      onPauseOpened = (): Promise<void> => Promise.resolve();
    }
    PauseListener({ name: "ok-pause-listener" })(Handler);
    // @ts-expect-error a class without onPauseClosed is no listener
    PauseListener({ name: "bad-pause-listener" })(NotAHandler);
  });
});
