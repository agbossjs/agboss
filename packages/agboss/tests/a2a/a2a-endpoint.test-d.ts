import { describe, expectTypeOf, it } from "vitest";
import {
  A2AEndpoint,
  type A2AEndpointOptions,
  type A2AEndpointSkill,
  type A2AEndpointTtl,
  type A2ASkillEntry,
} from "../../src/a2a/a2a-endpoint.decorator.js";
import type { A2AHttpListenerOptions } from "../../src/a2a/a2a-http.js";
import type { ApplicationOptions, RetentionOptions } from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { hours, minutes, type Milliseconds, Ttl } from "../../src/units/index.js";

/**
 * #1320a: `@A2AEndpoint({ name, version, description, ttl, skills })` — one `skills` list of starts
 * or starts with options, a required `ttl`; no `exports`, no map of skills by name, no `security`,
 * no `exposes` on `@Application`, no per-application A2A retention.
 */

class SomeStart {
  readonly kind = "start";
}

describe("#1320a: @A2AEndpoint's options", () => {
  it("has a typed skills list and a required ttl", () => {
    expectTypeOf<A2AEndpointOptions["skills"]>().toEqualTypeOf<readonly A2ASkillEntry[]>();
    expectTypeOf<A2ASkillEntry>().toEqualTypeOf<Class | A2AEndpointSkill>();
    expectTypeOf<A2AEndpointOptions["ttl"]>().toEqualTypeOf<A2AEndpointTtl>();
    expectTypeOf<A2AEndpointTtl["tasks"]>().toEqualTypeOf<Milliseconds | Ttl.Forever>();
    expectTypeOf<A2AEndpointTtl["messages"]>().toEqualTypeOf<Milliseconds>();
    expectTypeOf<A2AEndpointSkill["start"]>().toEqualTypeOf<Class>();
  });

  it("no longer has the exports list, the security schemes or a map of skills by name", () => {
    expectTypeOf<A2AEndpointOptions>().not.toHaveProperty("exports");
    expectTypeOf<A2AEndpointOptions>().not.toHaveProperty("security");
    expectTypeOf<A2AEndpointOptions["skills"]>().not.toEqualTypeOf<
      Readonly<Record<string, unknown>> | undefined
    >();
  });

  it("refuses an endpoint with no ttl, no skills, or the old shapes", () => {
    const base = { name: "n", version: "1", description: "d" } as const;
    const ttl = { tasks: hours(1), messages: minutes(1) };
    A2AEndpoint({ ...base, ttl, skills: [SomeStart, { start: SomeStart, tags: ["t"] }] });
    A2AEndpoint({ ...base, ttl: { tasks: Ttl.Forever, messages: minutes(1) }, skills: [] });
    // @ts-expect-error a ttl is required
    A2AEndpoint({ ...base, skills: [SomeStart] });
    // @ts-expect-error skills are required
    A2AEndpoint({ ...base, ttl });
    // @ts-expect-error `exports` is the old list: a start is a skill
    A2AEndpoint({ ...base, ttl, skills: [SomeStart], exports: [SomeStart] });
    // @ts-expect-error the old map of skills by the start's name
    A2AEndpoint({ ...base, ttl, skills: { "some-start": { tags: ["t"] } } });
    // @ts-expect-error a message ttl is a duration, never Ttl.Forever
    A2AEndpoint({ ...base, ttl: { tasks: hours(1), messages: Ttl.Forever }, skills: [] });
    // @ts-expect-error a skill with options names its start
    A2AEndpoint({ ...base, ttl, skills: [{ tags: ["t"] }] });
  });
});

describe("#1320a: what serves and lists it", () => {
  it("a listener takes its endpoint, a URL or a function of one, and the card's provider is the endpoint's", () => {
    expectTypeOf<A2AHttpListenerOptions["endpoint"]>().toEqualTypeOf<Class>();
    expectTypeOf<A2AHttpListenerOptions["publicUrl"]>().toEqualTypeOf<string | (() => string)>();
    expectTypeOf<A2AHttpListenerOptions>().not.toHaveProperty("expose");
    expectTypeOf<A2AHttpListenerOptions>().not.toHaveProperty("provider");
  });

  it("an application lists its endpoints; the exposes list and the A2A retentions are gone", () => {
    expectTypeOf<ApplicationOptions["endpoints"]>().toEqualTypeOf<readonly Class[] | undefined>();
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("exposes");
    expectTypeOf<RetentionOptions>().not.toHaveProperty("a2aTasks");
    expectTypeOf<RetentionOptions>().not.toHaveProperty("a2aMessages");
  });
});
