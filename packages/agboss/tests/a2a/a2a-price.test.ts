import { ConfigError } from "../../src/core/error-families/config-errors.js";
/**
 * #1382 (ledger-a2a-client shard) — an A2A contract's price is a finite number of dollars from 0, or none: the
 * check on its own, and what refuses it — `[a2a.cost-per-call-invalid]` at assembly of an `@A2AAgent`, and at the call of
 * a client built with a `contract`, before the card is read.
 */
import { describe, expect, it } from "vitest";
import { A2AAgent, A2AClient } from "../../src/a2a/index.js";
import { checkedCostPerCall, costPerCallProblemOf } from "../../src/a2a/a2a-rules.js";
import { applicationOf } from "../../src/application/assemble.js";
import { Application } from "../../src/application/application.js";
import type { Class } from "../../src/components/injection.js";
import { type RuleViolation } from "../../src/graph/rule-error.js";
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
    expect(costPerCallProblemOf(price)).toBeUndefined();
    expect(() => {
      checkedCostPerCall("peer-a2a-agent", price);
    }).not.toThrow();
  });

  it.each(BAD)("%s is a problem, named by its kind", (_name, price) => {
    const problem = costPerCallProblemOf(price);
    expect(problem).toMatch(
      /^costPerCall is .+, not a finite number of dollars from 0 — usd\(\.\.\.\)/,
    );
    expect(problem).not.toContain(SECRET);
    expect(problem).not.toContain("amount");
  });

  it("prints a number and names anything else by its kind", () => {
    expect(costPerCallProblemOf(-1)).toMatch(/^costPerCall is -1,/);
    expect(costPerCallProblemOf(Number.NaN)).toMatch(/^costPerCall is NaN,/);
    expect(costPerCallProblemOf(null)).toMatch(/^costPerCall is null,/);
    expect(costPerCallProblemOf(SECRET)).toMatch(/^costPerCall is a string,/);
    expect(costPerCallProblemOf({})).toMatch(/^costPerCall is an object,/);
  });

  it("checkedCostPerCall throws a ConfigError.Component [a2a.cost-per-call-invalid] naming the agent", () => {
    const refused = (() => {
      try {
        checkedCostPerCall("peer-a2a-agent", -1);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(ConfigError.Component);
    expect((refused as Error).message).toBe(
      `[a2a.cost-per-call-invalid] peer-a2a-agent: ${costPerCallProblemOf(-1) ?? ""}`,
    );
  });
});

/** An application listing one untyped `@A2AAgent` with the given price. */
function applicationWith(price: unknown): Class {
  @A2AAgent({ name: "priced-a2a-agent", url: AGENT_URL, costPerCall: price as never })
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
    await applicationOf(applicationWith(price), { withoutIdempotencyKeys: true });
  } catch (error) {
    if (error instanceof ConfigError.GraphRules) return error.violations;
    throw error;
  }
  return [];
};

describe("#1382: [a2a.cost-per-call-invalid] at assembly", () => {
  it.each(BAD)(
    "an @A2AAgent price of %s is refused, naming the agent and the value's kind",
    async (_name, price) => {
      const found = (await violationsOf(price)).filter(
        (one) => one.code === "a2a.cost-per-call-invalid",
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toBe(`priced-a2a-agent's ${costPerCallProblemOf(price) ?? ""}`);
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
        contract: { costPerCall: price as never },
        fetcher: () => {
          requests += 1;
          return Promise.reject(new Error("no request expected"));
        },
      });

      await expect(client.send("hi")).rejects.toThrow(
        /^\[a2a\.cost-per-call-invalid\] A2AClient: costPerCall is /,
      );
      await expect(client.send("hi")).rejects.not.toThrow(SECRET);
      expect(requests).toBe(0);
    },
  );
});
