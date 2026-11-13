/**
 * #812 AC5: what an application's A2A side says on its card, checked at assembly from the
 * declarations — `[a2a.expose-description-required]` (an error: a blank description),
 * `[a2a.skill-tags]` and `[a2a.unpriced-foreign-peer]` (warnings).
 */
import { describe, expect, it } from "vitest";
import { A2AAgent } from "../../src/a2a/a2a-decorator.js";
import { A2AExpose, type A2AExposeOptions } from "../../src/a2a/a2a-expose.decorator.js";
import { A2AClient } from "../../src/a2a/client/a2a-client.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { usd } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  BillingDeskA2AAgent,
  RefundWorkflow,
  RefundWorkflowStart,
} from "./fixtures/contracts.workflow.js";

@A2AAgent({ name: "weather-a2a-agent", url: "http://weather.invalid" })
class WeatherA2AAgent extends A2AClient {}

@A2AAgent({ name: "paid-a2a-agent", url: "http://paid.invalid", price: usd(0.01) })
class PaidA2AAgent extends A2AClient {}

function applicationWith(
  expose: Partial<A2AExposeOptions>,
  providers: readonly (typeof WeatherA2AAgent)[] = [],
) {
  @A2AExpose({
    name: "card-a2a-expose",
    version: "1.0.0",
    description: "A card",
    exports: [RefundWorkflowStart],
    ...expose,
  })
  class CardA2AExpose {}

  @Application({
    name: "card-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [RefundWorkflow],
    providers,
    budgets: TEST_BUDGETS,
    exposes: [CardA2AExpose],
  })
  class CardApplication {}
  return CardApplication;
}

const warningsOf = async (application: ReturnType<typeof applicationWith>): Promise<string[]> => {
  const assembled = await applicationOf(application);
  return assemblyWarningsOf({ ...assembled }).map(
    (warning) => `[${warning.code}] ${warning.message}`,
  );
};

describe("#812 AC5: [a2a.expose-description-required]", () => {
  it.each(["", "   "])("a blank description (%j) is refused at assembly", async (description) => {
    const built = applicationOf(applicationWith({ description }));

    await expect(built).rejects.toBeInstanceOf(GraphRuleError);
    await expect(built).rejects.toThrow(
      /\[a2a\.expose-description-required\] card-a2a-expose has no description/,
    );
  });

  it("a description assembles", async () => {
    await expect(applicationOf(applicationWith({}))).resolves.toBeDefined();
  });
});

describe("#812 AC5: [a2a.skill-tags] (a warning)", () => {
  const tagWarnings = (warnings: readonly string[]) =>
    warnings.filter((warning) => warning.startsWith("[a2a.skill-tags]"));

  it("a skill with no tags is named; its card says the application's name", async () => {
    const warnings = await warningsOf(applicationWith({}));

    expect(tagWarnings(warnings)).toEqual([
      expect.stringContaining(
        "card-a2a-expose lists the skill refund-workflow-start with no tags — its card says [card-application]",
      ),
    ]);
  });

  it("an empty list counts as no tags; a tag gives no warning", async () => {
    const empty = await warningsOf(
      applicationWith({ skills: { "refund-workflow-start": { tags: [] } } }),
    );
    const tagged = await warningsOf(
      applicationWith({ skills: { "refund-workflow-start": { tags: ["refunds"] } } }),
    );

    expect(tagWarnings(empty)).toHaveLength(1);
    expect(tagWarnings(tagged)).toEqual([]);
  });
});

describe("#812 AC5: [a2a.unpriced-foreign-peer] (a warning)", () => {
  const unpriced = (warnings: readonly string[]) =>
    warnings.filter((warning) => warning.startsWith("[a2a.unpriced-foreign-peer]"));

  it("a foreign agent with no price is named", async () => {
    const warnings = await warningsOf(applicationWith({}, [WeatherA2AAgent]));

    expect(unpriced(warnings)).toEqual([
      expect.stringContaining("weather-a2a-agent calls a peer that is not an AGBoss application"),
    ]);
  });

  it("not for a priced one, or for an AGBoss peer's", async () => {
    const priced = await warningsOf(applicationWith({}, [PaidA2AAgent]));
    const agboss = await warningsOf(applicationWith({}, [BillingDeskA2AAgent]));

    expect(unpriced(priced)).toEqual([]);
    expect(unpriced(agboss)).toEqual([]);
  });
});
