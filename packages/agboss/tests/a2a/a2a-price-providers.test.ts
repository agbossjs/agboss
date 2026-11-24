/**
 * #1366 (ledger-a2a-client shard) — `[a2a.cost-per-call-invalid]` looks at every `@A2AAgent` an application's assembly can
 * reach, wherever it is provided: the application's own `providers`, a listed workflow's, and a child workflow's that
 * only a listed workflow launches. A place the check does not look at leaves a negative price unrefused at assembly.
 */
import { describe, expect, it } from "vitest";
import { A2AAgent, A2AClient } from "../../src/a2a/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { InjectionToken, provide } from "../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { usd } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { AGENT_URL } from "./client/support/sdk-agent.js";

/** Where the `@A2AAgent` is provided. */
const PLACES = [
  "application",
  "listed workflow",
  "child workflow",
  "application, for a token",
  "listed workflow, for a token",
] as const;
type Place = (typeof PLACES)[number];

let count = 0;

/** An application that provides one `@A2AAgent` with `price` in `place`, and the codes its assembly refuses with. */
async function codesOf(place: Place, price: unknown): Promise<readonly string[]> {
  count += 1;
  const n = String(count);
  @A2AAgent({ name: `placed-${n}-a2a-agent`, url: AGENT_URL, costPerCall: price as never })
  class PlacedA2AAgent extends A2AClient {}

  const token = new InjectionToken<A2AClient>(`placed-${n}-token`);
  /** `providers` of the part named `at`: the agent in it listed, or given for a token, or nothing. */
  const providers = (at: "application" | "listed workflow" | "child workflow") => {
    if (place === at) return { providers: [PlacedA2AAgent] };
    if (place === `${at}, for a token`) return { providers: [provide(token, PlacedA2AAgent)] };
    return {};
  };

  @WorkflowStart({
    name: `placed-child-${n}-workflow-start`,
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class ChildStart {}
  @WorkflowFinish({
    name: `placed-child-${n}-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class ChildFinish {}
  @Workflow({
    name: `placed-child-${n}-workflow`,
    version: "1.0.0",
    flow: [onStart(ChildStart).toFinish(ChildFinish)],
    ...providers("child workflow"),
  })
  class ChildWorkflow {}

  @WorkflowStart({
    name: `placed-parent-${n}-workflow-start`,
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class ParentStart {}
  @WorkflowFinish({
    name: `placed-parent-${n}-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class ParentFinish {}
  @Workflow({
    name: `placed-parent-${n}-workflow`,
    version: "1.0.0",
    flow: [onStart(ParentStart).toWorkflow(ChildWorkflow).toFinish(ParentFinish)],
    ...providers("listed workflow"),
  })
  class ParentWorkflow {}

  @Application({
    name: `placed-${n}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ParentWorkflow],
    budgets: TEST_BUDGETS,
    ...providers("application"),
  })
  class PlacedApplication {}

  try {
    await applicationOf(PlacedApplication);
  } catch (error) {
    if (error instanceof GraphRuleError) return error.violations.map((found) => found.code);
    throw error;
  }
  return [];
}

describe("#1366: [a2a.cost-per-call-invalid] reaches an @A2AAgent wherever it is provided", () => {
  it.each(PLACES)("a negative price provided by the %s is refused at assembly", async (place) => {
    const codes = await codesOf(place, -1);
    expect(codes.filter((code) => code === "a2a.cost-per-call-invalid")).toHaveLength(1);
  });

  it.each(PLACES)("a priced agent provided by the %s is accepted", async (place) => {
    expect(await codesOf(place, usd(0.25))).not.toContain("a2a.cost-per-call-invalid");
  });
});

describe("#1366: a class listed as a workflow that is none is a rule violation, not a crash", () => {
  it("[application.not-a-workflow] and [a2a.cost-per-call-invalid] are both reported", async () => {
    @A2AAgent({ name: "beside-a2a-agent", url: AGENT_URL, costPerCall: -1 as never })
    class BesideA2AAgent extends A2AClient {}
    class NotAWorkflow {
      readonly plain = true;
    }

    @Application({
      name: "beside-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [NotAWorkflow],
      providers: [BesideA2AAgent],
      budgets: TEST_BUDGETS,
    })
    class BesideApplication {}

    const error: unknown = await applicationOf(BesideApplication).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(GraphRuleError);
    const codes = (error as GraphRuleError).violations.map((found) => found.code);
    expect(codes).toContain("application.not-a-workflow");
    expect(codes.filter((code) => code === "a2a.cost-per-call-invalid")).toHaveLength(1);
  });
});
