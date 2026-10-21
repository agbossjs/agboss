import { describe, expect, it } from "vitest";
import { createAppDeps } from "../../../src/app/app-deps.js";
import { workflowInApplication } from "../../../src/application/workflow-application.js";
import { studioGraph } from "../../../src/graph/studio-graph.js";
import { studioOf } from "../../../src/studio.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { CompanyReviewApplication, JobOfferWorkflow } from "../fixtures/children.fixture.js";
import { RecursionApplication, TopicResearchWorkflow } from "./fixtures/recursion.workflow.js";

/**
 * #263 S37 (#268 AC7): a child is a subgraph node of its parent — Studio draws it inside; a
 * workflow on its own (Studio, eval) builds its children's deps too. `studioOf(Application)` is what
 * `agboss studio` serves: every workflow of the application, by name.
 */

const scripted = (): ReturnType<typeof createScriptedGateway> =>
  createScriptedGateway(new ScriptBook());

/** The node ids Studio gets for a workflow of the application (`GET …/graph?xray=true`). */
async function drawnNodes(
  application: typeof CompanyReviewApplication | typeof RecursionApplication,
  workflow: string,
): Promise<Readonly<Record<string, { readonly metadata?: Record<string, unknown> }>>> {
  const studio = await studioOf(application, { processEnv: {}, gateway: scripted() });
  try {
    return (await studio.graph(workflow).getGraphAsync({ xray: true })).nodes;
  } finally {
    await studio.close();
  }
}

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

describe("#268 AC7: studioOf(Application) — every workflow, children inside their parent", () => {
  it("lists every workflow of the application by name, the children too", async () => {
    const studio = await studioOf(CompanyReviewApplication, {
      processEnv: {},
      gateway: scripted(),
    });
    await studio.close();

    expect(studio.names).toEqual([
      "company-review-workflow",
      "company-screening-workflow",
      "job-offer-workflow",
      "link-offer-workflow",
    ]);
    expect(() => studio.graph("company-review")).toThrow(
      'company-review-application has no workflow "company-review"; its workflows: company-review-workflow, company-screening-workflow, job-offer-workflow, link-offer-workflow',
    );
  });

  it("a child entered by .toWorkflow(W) is a subgraph of its parent", async () => {
    const ids = Object.keys(await drawnNodes(CompanyReviewApplication, "job-offer-workflow"));

    expect(ids).toEqual(
      expect.arrayContaining([
        "company-picker-agent",
        "company-review-workflow:company-reviewer-agent",
      ]),
    );
  });

  it("a child per item (.toParallelWorkflows) is a subgraph of its parent too", async () => {
    const ids = Object.keys(
      await drawnNodes(CompanyReviewApplication, "company-screening-workflow"),
    );

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

  it("studioOf(Application) draws it the same way", async () => {
    const nodes = await drawnNodes(RecursionApplication, "topic-research-workflow");

    expect(Object.keys(nodes).filter((id) => id.startsWith("this-workflow:"))).toEqual([]);
    expect(nodes["this-workflow"]?.metadata).toEqual({ recursive: "maxDepth 3" });
  });
});
