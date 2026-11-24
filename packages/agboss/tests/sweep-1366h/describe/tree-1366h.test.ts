/**
 * #1366: `agboss describe` shows each child launch as it is declared — which steps launch it, one
 * child or one per item, its `maxItems` and `maxConcurrency` only when written, a recursive child's
 * `maxDepth` only when written — down to the grandchildren, in the data and in the text.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import type { Class } from "../../../src/components/injection.js";
import { describedTreeOf, treeLines } from "../../../src/describe/tree.js";
import { WorkflowFinishTextDto } from "../../../src/dto/index.js";
import { WorkflowStartTextDto } from "../../flow/fixtures/dtos.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { onStart, toWorkflow } from "../../helpers/flow.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { DeepResearchWorkflow } from "../../flow/fixtures/recursion.fixture.js";
import {
  BatchSummaryAgent,
  SplitRequestsAction,
  TreasuryDeskWorkflow,
  TreasuryWorkflow,
  treasuryChannels,
} from "../../flow/fixtures/replies.fixture.js";
import { Ttl } from "../../../src/index.js";

const applicationOver = async (...workflows: Class[]) => {
  @Application({
    name: "tree-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows,
    budgets: TEST_BUDGETS,
    providers: treasuryChannels,
  })
  class TreeApplication {}
  return applicationOf(TreeApplication);
};

/** A workflow that splits a request and launches the treasury once per line, with these options. */
const perItemWorkflow = (name: string, options: { takeFirst: number; maxConcurrency?: number }) => {
  @WorkflowStart({
    name: `${name}-workflow-start`,
    description: "Lines",
    input: WorkflowStartTextDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `${name}-workflow-finish`,
    description: "Answer",
    output: WorkflowFinishTextDto,
  })
  class Finish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "2.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(Start)
        .toAction(SplitRequestsAction)
        .forEachItem(toWorkflow(TreasuryWorkflow), options)
        .join()
        .toAgent(BatchSummaryAgent)
        .toFinish(Finish),
    ],
  })
  class PerItem {}
  return PerItem;
};

describe("#1366: the launch of a child in the tree", () => {
  it("one child: no limits; per item: only the limits that are written", async () => {
    const tree = describedTreeOf(
      await applicationOver(
        TreasuryWorkflow,
        perItemWorkflow("items", { takeFirst: 4 }),
        perItemWorkflow("slots", { takeFirst: 6, maxConcurrency: 2 }),
      ),
    );

    expect(
      tree.workflows.map((workflow) => workflow.children.map((child) => child.launch)),
    ).toStrictEqual([
      [],
      [{ from: ["split-requests-action"], isPerItem: true, maxItems: 4 }],
      [{ from: ["split-requests-action"], isPerItem: true, maxItems: 6, maxConcurrency: 2 }],
    ]);
  });

  it("the text: the limits written, in order, each with its number", async () => {
    const lines = treeLines(
      await applicationOver(
        TreasuryWorkflow,
        perItemWorkflow("items", { takeFirst: 4 }),
        perItemWorkflow("both", { takeFirst: 5, maxConcurrency: 3 }),
      ),
    );

    expect(lines.filter((line) => line.includes("child"))).toStrictEqual([
      "    child treasury-workflow 1.0.0 per item from split-requests-action (maxItems 4)",
      "    child treasury-workflow 1.0.0 per item from split-requests-action (maxItems 5, maxConcurrency 3)",
    ]);
  });

  it("grandchildren: a child's own children sit one level deeper, each with its starts", async () => {
    @WorkflowStart({
      name: "grand-workflow-start",
      description: "Ask",
      input: WorkflowStartTextDto,
    })
    class GrandStart {}
    @WorkflowFinish({
      name: "grand-workflow-finish",
      description: "Answer",
      output: WorkflowFinishTextDto,
    })
    class GrandFinish {}
    @Workflow({
      name: "grand-workflow",
      version: "3.1.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(GrandStart).toWorkflow(TreasuryDeskWorkflow).toFinish(GrandFinish)],
    })
    class GrandWorkflow {}

    const assembled = await applicationOver(GrandWorkflow, TreasuryDeskWorkflow, TreasuryWorkflow);
    const [grand] = describedTreeOf(assembled).workflows;

    expect(grand?.children.map((child) => child.workflow.name)).toStrictEqual([
      "treasury-desk-workflow",
    ]);
    expect(grand?.children[0]?.workflow.children.map((child) => child.workflow.name)).toStrictEqual(
      ["treasury-workflow"],
    );
    expect(treeLines(assembled).slice(0, 7)).toStrictEqual([
      "workflows",
      "  grand-workflow 3.1.0",
      "    start grand-workflow-start (WorkflowStartTextDto)",
      "    child treasury-desk-workflow 1.0.0 from grand-workflow-start",
      "      start treasury-desk-workflow-start (WorkflowStartTextDto)",
      "      child treasury-workflow 1.0.0 from treasury-desk-workflow-start",
      "        start treasury-workflow-start (WorkflowStartTextDto)",
    ]);
  });
});

describe("#1366: a recursive child in the tree", () => {
  it("is the workflow again — name and version, no starts, no children — with its maxDepth", async () => {
    const assembled = await applicationOver(DeepResearchWorkflow);
    const [research] = describedTreeOf(assembled).workflows;

    expect(research?.children).toStrictEqual([
      {
        launch: { from: ["split-topic-action"], isPerItem: true, maxItems: 5, maxConcurrency: 3 },
        isRecursive: true,
        maxDepth: 4,
        workflow: { name: "deep-research-workflow", version: "1.0.0", starts: [], children: [] },
      },
    ]);
  });
});
