import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScaffoldError } from "../../src/scaffold/errors.js";
import { FINISH_ROUTE_TEXT, MAIN_ROUTER } from "../../src/scaffold/flow-files.js";
import { planGenerate } from "../../src/scaffold/generate.js";
import { addAgentToFlow } from "../../src/scaffold/wire-flow.js";
import { workflowDeclaration, writeApplication } from "./application-fixture.js";

const workflow = (flow: string) => ({ path: "src/desk/desk.workflow.ts", content: flow });

describe("#116: agboss g agent joins the router's choice; agboss g router", () => {
  const TRIAGE = "      route(TriageAgent)\n        .toFinish(TextWorkflowFinish)";
  const BILLING = "      route(BillingAgent)\n        .toFinish(TextWorkflowFinish)";
  const STAR = (routes: string) =>
    `flow: [\n  start(TextWorkflowStart)\n    .returns(WorkflowStartTextDto)\n    .toRouter(MainRouter)\n    .chooseOne(\n${routes},\n    ),\n]`;

  it("#272: adds route(Agent).toFinish(Finish) after the router's last route, one call per line (#289)", () => {
    const file = workflow(STAR(TRIAGE));

    expect(addAgentToFlow(file, "BillingAgent", "MainRouter", "TextWorkflowFinish").content).toBe(
      STAR(`${TRIAGE},\n${BILLING}`),
    );
  });

  it("#289: a route written on the chooseOne line gets the new one on its own lines, a step in", () => {
    const file = workflow(
      "[\n  router(MainRouter).chooseOne(route(TriageAgent).toFinish(Done)),\n]",
    );

    expect(addAgentToFlow(file, "BillingAgent", "MainRouter", "Done").content).toBe(
      "[\n  router(MainRouter).chooseOne(route(TriageAgent).toFinish(Done),\n    route(BillingAgent)\n      .toFinish(Done)),\n]",
    );
  });

  it("an unexpected flow is not guessed: an error naming the file", () => {
    const file = workflow(
      "[start(TextWorkflowStart).returns(WorkflowStartTextDto).toAgent(TriageAgent).toFinish(TextWorkflowFinish)]",
    );

    expect(() => addAgentToFlow(file, "BillingAgent", "MainRouter", "TextWorkflowFinish")).toThrow(
      ScaffoldError,
    );
    expect(() => addAgentToFlow(file, "BillingAgent", "MainRouter", "TextWorkflowFinish")).toThrow(
      "src/desk/desk.workflow.ts: no .toRouter(MainRouter).chooseOne(route(…)…) in the flow — add BillingAgent by hand",
    );
  });

  it("adding an agent that is already in the choice doubles nothing: it is reported as skipped", () => {
    const file = workflow(
      "[router(MainRouter).chooseOne(route(TriageAgent).toFinish(Done), route(BillingAgent).toFinish(Done))]",
    );

    const again = addAgentToFlow(file, "BillingAgent", "MainRouter", "Done");

    expect(again.content).toBe(file.content);
    expect(again.skipped).toEqual([
      "src/desk/desk.workflow.ts: BillingAgent already in MainRouter's chooseOne(…)",
    ]);
  });

  it("agboss g router routes to the finish the workflow imports, whatever its file is called", async () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-router-"));
    mkdirSync(join(root, "src/desk/ends"), { recursive: true });
    const desk = { module: "src/desk/desk.workflow.ts", className: "Desk", name: "desk-workflow" };
    writeApplication(root, desk);
    writeFileSync(join(root, desk.module), workflowDeclaration(desk));
    const options = { workflow: "desk-workflow" };

    await expect(planGenerate("router", "escalation-router", options, root)).rejects.toThrow(
      "src/desk/desk.workflow.ts: imports no @WorkflowFinish class",
    );
    writeFileSync(
      join(root, desk.module),
      `import { DoneFinish } from "./ends/done.ts";\n${workflowDeclaration(desk)}`,
    );
    writeFileSync(
      join(root, "src/desk/ends/done.ts"),
      '@WorkflowFinish({ name: "done", output: X })\nexport class DoneFinish {}\n',
    );
    const [router] = (await planGenerate("router", "escalation-router", options, root)).create;
    expect(router?.path).toBe("src/desk/routers/escalation/escalation.router.ts");
    expect(router?.content).toContain("export class EscalationRouter {}");
    expect(router?.content).toContain('import { DoneFinish } from "../../ends/done.js";');
    expect(router?.content).toContain(
      '{ prompt: "Stop and send the answer: the contributions so far answer the message',
    );
    // #142 AC3: a new router is bounded on any cycle it is later put on
    expect(router?.content).toContain("  maxVisits: 1,\n");
  });
});

describe("#197: the router prompts every scaffold writes", () => {
  it("the finish route is the stop instruction CLAUDE.md prescribes, pinned word for word", () => {
    const guide = readFileSync(new URL("../../../../CLAUDE.md", import.meta.url), "utf8");
    const [, prefix] = /\("(Stop and send the answer:) …"\)/.exec(guide) ?? [];

    expect(prefix).toBe("Stop and send the answer:");
    expect(FINISH_ROUTE_TEXT.startsWith(`${prefix ?? "?"} `)).toBe(true);
    expect(FINISH_ROUTE_TEXT).toBe(
      "Stop and send the answer: the contributions so far answer the message, or the last agent asked a question and waits for the reply, or it cannot be done",
    );
    expect(MAIN_ROUTER).toEqual({
      description: "Sends the message to the agent that answers it",
      prompt: "Pick the agent that answers the message.",
      maxVisits: 3,
    });
  });
});
