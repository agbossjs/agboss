/** #1307 b17: names the target/channel split and the store move removed stay removed. */
import { describe, expectTypeOf, it } from "vitest";
import * as root from "../../src/index.js";
import * as stores from "../../src/stores/index.js";
import type { ChannelSender } from "../../src/channels/channel-sender.js";

describe("#1307: removed names", () => {
  it("the store-implementer names left the root entry for /stores", () => {
    // @ts-expect-error pauseKeyOf is a store helper: @agboss/core/stores
    expectTypeOf(root.pauseKeyOf).toBeFunction();
    expectTypeOf(stores.pauseKeyOf).toBeFunction();
    expectTypeOf<stores.PauseAnswer>().not.toBeAny();
    expectTypeOf<stores.PauseSite>().not.toBeAny();
    // @ts-expect-error PauseAnswer is a store type: @agboss/core/stores
    expectTypeOf<root.PauseAnswer>().toBeAny();
    // @ts-expect-error PauseSite is a store type: @agboss/core/stores
    expectTypeOf<root.PauseSite>().toBeAny();
  });

  it("the channel no longer decides an expiry", () => {
    // @ts-expect-error onPauseExpired moved to the target class as onExpired
    expectTypeOf<ChannelSender["onPauseExpired"]>().toBeUndefined();
  });

  it("0.1.0 roles, listeners and hooks are gone", () => {
    // @ts-expect-error replaced by @ToolApproval / @ExternalTask
    expectTypeOf(root.ChannelRole).toBeFunction();
    // @ts-expect-error replaced by @Channel({ target })
    expectTypeOf(root.ChannelOf).toBeFunction();
    // @ts-expect-error replaced by PauseRespondent
    expectTypeOf(root.PauseAnswerer).toBeObject();
    // @ts-expect-error replaced by @ChannelListener
    expectTypeOf(root.PauseListener).toBeFunction();
    // @ts-expect-error replaced by @ChannelInterpreter
    expectTypeOf(root.ReplyInterpreter).toBeFunction();
  });
});
