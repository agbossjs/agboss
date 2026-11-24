import { describe, expectTypeOf, it } from "vitest";
import { Agent, type HealthCheckOptions, type ChannelListenerOptions } from "../../src/index.js";
import type { ChannelInterpreterOptions } from "../../src/channels/channel-interpreter.js";
import type { ModelProviderOptions } from "../../src/models/model-provider.decorator.js";

/** #1343a: the name of a non-persisted component is optional; a persisted one keeps it required. */
describe("#1343a: optional names", () => {
  it("the options accept no name", () => {
    expectTypeOf<HealthCheckOptions["name"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelListenerOptions["name"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ChannelInterpreterOptions["name"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ModelProviderOptions["name"]>().toEqualTypeOf<string | undefined>();
  });

  it("an @Agent keeps its required name", () => {
    // @ts-expect-error -- a persisted component's name is required
    Agent({ description: "a", prompt: "p", model: "test/a" });
  });
});
