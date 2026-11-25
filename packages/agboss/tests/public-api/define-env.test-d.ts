/**
 * #1324b, at compile time: `defineEnv` infers each key's resolved type from its reader, a secret resolves
 * to `Secret`, an optional one to `Secret | undefined`, `deps: [appEnv]` injects the values, a reserved key
 * and a plain value do not compile, and `env.ttl` is wide only where `{ allowNone: true }` says so.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Resolved } from "../../src/components/injection.js";
import {
  bearer,
  configureEnv,
  defineEnv,
  env,
  secret,
  Ttl,
  type EnvRef,
  type InferEnv,
  type Secret,
  type SecretRef,
} from "../../src/index.js";
import type { Bytes, Milliseconds, Usd } from "../../src/units/index.js";

const appEnv = defineEnv({
  region: env("REGION"),
  port: env.integer("PORT"),
  debug: env.boolean("DEBUG"),
  ratio: env.number("RATIO"),
  deadline: env.duration("D"),
  history: env.ttl("H"),
  audit: env.ttl("A", { allowNone: true }),
  size: env.bytes("S"),
  budget: env.usd("B"),
  nickname: env.optional("N"),
  apiKey: secret("KEY"),
  token: secret.optional("T"),
});

describe("#1324b: InferEnv", () => {
  it("each key resolves to the type of its reader", () => {
    type Values = InferEnv<typeof appEnv>;

    expectTypeOf<Values["region"]>().toEqualTypeOf<string>();
    expectTypeOf<Values["port"]>().toEqualTypeOf<number>();
    expectTypeOf<Values["debug"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Values["ratio"]>().toEqualTypeOf<number>();
    expectTypeOf<Values["deadline"]>().toEqualTypeOf<Milliseconds>();
    expectTypeOf<Values["history"]>().toEqualTypeOf<Milliseconds | Ttl.Forever>();
    expectTypeOf<Values["audit"]>().toEqualTypeOf<Milliseconds | Ttl>();
    expectTypeOf<Values["size"]>().toEqualTypeOf<Bytes>();
    expectTypeOf<Values["budget"]>().toEqualTypeOf<Usd>();
    expectTypeOf<Values["nickname"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Values["apiKey"]>().toEqualTypeOf<Secret>();
    expectTypeOf<Values["token"]>().toEqualTypeOf<Secret | undefined>();
  });

  it("the dictionary's keys are the references a component option takes; `deps: [appEnv]` gives the values", () => {
    expectTypeOf(appEnv.apiKey).toExtend<SecretRef>();
    expectTypeOf(appEnv.budget).toExtend<EnvRef<Usd>>();
    expectTypeOf<Resolved<typeof appEnv>>().toEqualTypeOf<InferEnv<typeof appEnv>>();
    expectTypeOf(bearer(appEnv.apiKey).kind).toEqualTypeOf<"bearer">();
    expectTypeOf(configureEnv(appEnv, { region: "eu" }).contract).toEqualTypeOf<typeof appEnv>();
  });

  it("an old environment file still reads env() as its plain type", () => {
    const region: string = env("REGION");
    const port: number = env.integer("PORT");
    const optional: string | undefined = env.optional("X");
    const key: Secret = secret("K");

    expectTypeOf(region).toBeString();
    expectTypeOf(port).toBeNumber();
    expectTypeOf(optional).toExtend<string | undefined>();
    expectTypeOf(key).toEqualTypeOf<Secret>();
  });
});

describe("#1324b: what does not compile", () => {
  it("a reserved key", () => {
    // @ts-expect-error `then` would make the dictionary a thenable
    defineEnv({ then: env("X") });
    // @ts-expect-error `constructor` is reserved
    defineEnv({ constructor: env("X") });
  });

  it("a plain value in place of a reference", () => {
    // @ts-expect-error a key is an env(…) or secret(…) reference
    defineEnv({ port: 8080 });
  });
});
