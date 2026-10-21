/**
 * #268 AC4 — `agboss describe` of job-scout, as printed (M1): the tree with its start, each
 * contract's implementation and why, the model providers, the channel the shortlist tool names, the
 * budgets by scope, the environment with its secret masked, then the workflow — its guardrails and
 * PII policies, flow, inputs with their producers, limits with the worst case, `model → provider`.
 * No API key, no network. A change to job-scout or to describe updates the snapshot
 * (`npx vitest run -u`), reviewed like code.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agboss, envelope } from "./agboss.js";

const JOB_SCOUT = fileURLToPath(new URL("../../../../examples/job-scout/", import.meta.url));

describe("#268 AC4: agboss describe on job-scout", () => {
  it("the whole application, as printed (snapshot)", async () => {
    const call = await agboss(["describe"], JOB_SCOUT);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    await expect(call.stdout).toMatchFileSnapshot("./__snapshots__/job-scout.describe.txt");
  });

  it("--json: the application's tree, implementations, model providers, channels and budgets", async () => {
    const call = await agboss(["describe", "--json"], JOB_SCOUT);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        application: {
          name: "job-scout-application",
          tree: [
            {
              name: "job-scout-workflow",
              starts: ["chat-workflow-start (WorkflowStartTextDto)"],
              children: [],
            },
          ],
          modelProviders: [
            { name: "openrouter-model-provider", className: "OpenRouterModelProvider" },
            { name: "decisions-model-provider", className: "DecisionsModelProvider" },
          ],
          channels: [
            {
              name: "terminal-user-channel",
              question: "ChosenJobs",
              answer: "ToolCallApprovalDecisionDto",
              tools: ["save_shortlist (job-scout-workflow)"],
            },
          ],
          executionBudgets: [
            { workflow: "job-scout-workflow", name: "execution-budget", isOwn: false },
          ],
        },
        workflows: [{ name: "job-scout-workflow", piiPolicies: [] }],
      },
    });
  });
});
