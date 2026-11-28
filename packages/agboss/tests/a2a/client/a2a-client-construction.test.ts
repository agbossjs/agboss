/**
 * #1356 (ledger-a2a-client shard): what constructing an A2A client does and does not do, and what it is counted as —
 * a client of an address that is a reference is not read at construction (a missing variable is named at first use,
 * never at `new`), a client without both DTOs refuses a typed call with `[a2a.no-contract]`, and a component that
 * reaches a client is one that reaches a writer under business keys (#1317d).
 */
import { describe, expect, it } from "vitest";
import { A2AAgent } from "../../../src/a2a/a2a-decorator.js";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import { businessKeyWriterUseOf } from "../../../src/components/container/fenced-reach.js";
import { defineEnv, env } from "../../../src/index.js";
import { AGENT_URL } from "./support/sdk-agent.js";

describe("#1356: an A2A client at construction", () => {
  it("does not read the environment for an address that is a reference: its variable is asked for at first use", () => {
    const own = defineEnv({ url: env("A2A_CONSTRUCTION_TEST_URL") });
    @A2AAgent({ name: "late-a2a-agent", url: own.url })
    class Late extends A2AClient {}

    const client = new Late();
    expect(() => client.url).toThrow(/A2A_CONSTRUCTION_TEST_URL/u);

    process.env.A2A_CONSTRUCTION_TEST_URL = AGENT_URL;
    try {
      expect(new Late().url).toBe(AGENT_URL);
    } finally {
      delete process.env.A2A_CONSTRUCTION_TEST_URL;
    }
  });

  it("refuses a typed call of a client that has no contract: [a2a.no-contract], not a failure to read one", async () => {
    @A2AAgent({ name: "bare-a2a-agent", url: AGENT_URL })
    class Bare extends A2AClient {}

    await expect(new Bare().execute({})).rejects.toThrow("[a2a.no-contract]");
  });

  it("is a writer under business keys: a component that reaches it is told so", () => {
    @A2AAgent({ name: "desk-a2a-agent", url: AGENT_URL })
    class Desk extends A2AClient {}
    class Reaching {
      readonly kind = "reaching";
    }

    expect(businessKeyWriterUseOf([Reaching], (cls) => (cls === Reaching ? [Desk] : []))).toEqual({
      component: Reaching,
      writer: Desk,
    });
    expect(businessKeyWriterUseOf([Reaching], () => [])).toBeUndefined();
  });
});
