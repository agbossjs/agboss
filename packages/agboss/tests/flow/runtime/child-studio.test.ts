import { describe, expect, it } from "vitest";
import { createAppDeps } from "../../../src/app/app-deps.js";
import { workflowInApplication } from "../../../src/application/workflow-application.js";
import { studioGraph } from "../../../src/graph/studio-graph.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { JobOfferWorkflow } from "../fixtures/children.fixture.js";
import { TopicResearchWorkflow } from "./fixtures/recursion.workflow.js";

/**
 * #263 S37 (#268 AC7): a child is a subgraph node of its parent — Studio draws it inside; a
 * workflow on its own (Studio, eval) builds its children's deps too.
 */

describe("S37: the child inside its parent", () => {
  it("getGraphAsync({ xray: true }) shows the child's nodes inside the parent's node", async () => {
    const bundle = await workflowInApplication(JobOfferWorkflow);
    const deps = await createAppDeps(bundle, { gateway: createScriptedGateway(new ScriptBook()) });

    const drawn = await studioGraph(deps).getGraphAsync({ xray: true });
    await deps.close();

    const ids = Object.keys(drawn.nodes);
    expect(ids).toEqual(expect.arrayContaining(["company-picker-agent"]));
    expect(ids.filter((id) => id.startsWith("company-review-workflow:"))).toEqual(
      expect.arrayContaining(["company-review-workflow:company-reviewer-agent"]),
    );
  });
});

describe("#264: ThisWorkflow in Studio", () => {
  it("a node marked recursive: maxDepth N, never its own subgraph", async () => {
    const bundle = await workflowInApplication(TopicResearchWorkflow);
    const deps = await createAppDeps(bundle, { gateway: createScriptedGateway(new ScriptBook()) });

    const drawn = await studioGraph(deps).getGraphAsync({ xray: true });
    await deps.close();

    const ids = Object.keys(drawn.nodes);
    expect(ids).toContain("this-workflow");
    expect(ids.filter((id) => id.startsWith("this-workflow:"))).toEqual([]);
    expect(drawn.nodes["this-workflow"]?.metadata).toEqual({ recursive: "maxDepth 3" });
  });
});
