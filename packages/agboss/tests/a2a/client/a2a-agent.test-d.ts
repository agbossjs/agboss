import { describe, expectTypeOf, it } from "vitest";
import type { A2AAgentConfig } from "../../../src/a2a/a2a-decorator.js";
import { A2AAgent } from "../../../src/a2a/a2a-decorator.js";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import type { EnvRef, SecretRef } from "../../../src/environments/env-ref.js";
import type { HeaderSecretTemplate } from "../../../src/environments/define-env.js";
import type { Milliseconds, Usd } from "../../../src/units/index.js";
import { seconds, usd } from "../../../src/units/index.js";

/** #1320b: `@A2AAgent({ url: string | EnvRef, headers, timeout, costPerCall })`; `price` is gone. */
describe("#1320b: @A2AAgent's options", () => {
  it("takes a url or a reference, declared headers, a timeout and costPerCall", () => {
    expectTypeOf<A2AAgentConfig["url"]>().toEqualTypeOf<string | EnvRef<string>>();
    expectTypeOf<A2AAgentConfig["timeout"]>().toEqualTypeOf<Milliseconds | undefined>();
    expectTypeOf<A2AAgentConfig["costPerCall"]>().toEqualTypeOf<Usd | undefined>();
    expectTypeOf<NonNullable<A2AAgentConfig["headers"]>[string]>().toEqualTypeOf<
      string | EnvRef<string> | SecretRef | HeaderSecretTemplate
    >();
    expectTypeOf<A2AAgentConfig["allowedOrigins"]>().toEqualTypeOf<
      readonly (string | EnvRef<string>)[] | undefined
    >();
  });

  it("has no price", () => {
    expectTypeOf<A2AAgentConfig>().not.toHaveProperty("price");
    // @ts-expect-error `price` is `costPerCall` now
    A2AAgent({ name: "a", url: "http://a.example", price: usd(1) })(class extends A2AClient {});
    A2AAgent({ name: "a", url: "http://a.example", costPerCall: usd(1), timeout: seconds(3) })(
      class extends A2AClient {},
    );
  });

  it("a subclass's getHeaders may be sync or async", () => {
    class Sync extends A2AClient {
      protected override getHeaders(): Record<string, string> {
        return {};
      }
    }
    class Async extends A2AClient {
      protected override getHeaders(): Promise<Record<string, string>> {
        return Promise.resolve({});
      }
    }
    expectTypeOf<Sync>().toExtend<A2AClient>();
    expectTypeOf<Async>().toExtend<A2AClient>();
  });
});
