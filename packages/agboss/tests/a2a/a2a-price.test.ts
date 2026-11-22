/**
 * #1382 (ledger-a2a-client shard) — an A2A contract's price is a finite number of dollars from 0, or none: the
 * check on its own, and what refuses it — `[a2a.price-invalid]` at assembly of an `@A2AAgent`, and at the call of
 * a client built with a `contract`, before the card is read.
 */
import { describe, expect, it } from "vitest";
import { A2AAgent, A2AClient } from "../../src/a2a/index.js";
import { checkedPrice, priceProblemOf } from "../../src/a2a/a2a-rules.js";
import { applicationOf } from "../../src/application/assemble.js";
import { Application } from "../../src/application/application.js";
import { ComponentError } from "../../src/components/metadata.js";
import type { Class } from "../../src/components/injection.js";
import { GraphRuleError, type RuleViolation } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { usd } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { FileSummaryWorkflow } from "./fixtures/files.application.js";
import { AGENT_URL } from "./client/support/sdk-agent.js";

const SECRET = "sk-live-secret-text";
const BAD: readonly [string, unknown][] = [
  ["a negative number", -1],
  ["a negative fraction", -0.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["a word", "five"],
  ["null", null],
  ["an object", { amount: 5 }],
  ["a secret text", SECRET],
];

describe("#1382: a price is a finite number of dollars from 0", () => {
  it.each([undefined, 0, -0, 0.25, 3, 1e9])("%s is no problem", (price) => {
    expect(priceProblemOf(price)).toBeUndefined();
    expect(() => {
      checkedPrice("peer-a2a-agent", price);
    }).not.toThrow();
  });

  it.each(BAD)("%s is a problem, named by its kind", (_name, price) => {
    const problem = priceProblemOf(price);
    expect(problem).toMatch(/^price is .+, not a finite number of dollars from 0 — usd\(\.\.\.\)/);
    expect(problem).not.toContain(SECRET);
    expect(problem).not.toContain("amount");
  });

  it("prints a number and names anything else by its kind", () => {
    expect(priceProblemOf(-1)).toMatch(/^price is -1,/);
    expect(priceProblemOf(Number.NaN)).toMatch(/^price is NaN,/);
    expect(priceProblemOf(null)).toMatch(/^price is null,/);
    expect(priceProblemOf(SECRET)).toMatch(/^price is a string,/);
    expect(priceProblemOf({})).toMatch(/^price is an object,/);
  });

  it("checkedPrice throws a ComponentError [a2a.price-invalid] naming the agent", () => {
    const refused = (() => {
      try {
        checkedPrice("peer-a2a-agent", -1);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(ComponentError);
    expect((refused as Error).message).toBe(
      `[a2a.price-invalid] peer-a2a-agent: ${priceProblemOf(-1) ?? ""}`,
    );
  });
});

/** An application listing one untyped `@A2AAgent` with the given price. */
function applicationWith(price: unknown): Class {
  @A2AAgent({ name: "priced-a2a-agent", url: AGENT_URL, price: price as never })
  class PricedA2AAgent extends A2AClient {}

  @Application({
    name: "priced-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [FileSummaryWorkflow],
    providers: [PricedA2AAgent],
    budgets: TEST_BUDGETS,
  })
  class PricedApplication {}
  return PricedApplication;
}

const violationsOf = async (price: unknown): Promise<readonly RuleViolation[]> => {
  try {
    await applicationOf(applicationWith(price));
  } catch (error) {
    if (error instanceof GraphRuleError) return error.violations;
    throw error;
  }
  return [];
};

describe("#1382: [a2a.price-invalid] at assembly", () => {
  it.each(BAD)(
    "an @A2AAgent price of %s is refused, naming the agent and the value's kind",
    async (_name, price) => {
      const found = (await violationsOf(price)).filter((one) => one.code === "a2a.price-invalid");
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toBe(`priced-a2a-agent's ${priceProblemOf(price) ?? ""}`);
      expect(found[0]?.nodes).toEqual(["priced-application"]);
      expect(JSON.stringify(found)).not.toContain(SECRET);
    },
  );

  it.each([undefined, usd(0), usd(0.25)])("an @A2AAgent price of %s is accepted", async (price) => {
    expect(await violationsOf(price)).toEqual([]);
  });
});

describe("#1382: a client built with a contract refuses its price before any request", () => {
  it.each(BAD)(
    "a contract price of %s: send throws and the fetcher is never called",
    async (_name, price) => {
      let requests = 0;
      const client = new A2AClient({
        url: AGENT_URL,
        contract: { price: price as never },
        fetcher: () => {
          requests += 1;
          return Promise.reject(new Error("no request expected"));
        },
      });

      await expect(client.send("hi")).rejects.toThrow(
        /^\[a2a\.price-invalid\] A2AClient: price is /,
      );
      await expect(client.send("hi")).rejects.not.toThrow(SECRET);
      expect(requests).toBe(0);
    },
  );
});
