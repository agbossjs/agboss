/**
 * #268 AC4 — `agboss describe` of job-scout, as printed (M1): the tree with its start, each
 * contract's implementation and why, the model providers, the channel the shortlist tool names, the
 * budgets by scope, the environment with its secret masked, then the workflow — its guardrails and
 * PII policies, flow, inputs with their producers, limits with the worst case, `model → provider`.
 * No API key, no network (the config hash, which depends on the checkout, is masked). A change to
 * job-scout or to describe updates the snapshot
 * (`npx vitest run -u`), reviewed like code.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agboss, envelope } from "./agboss.js";

const JOB_SCOUT = fileURLToPath(new URL("../../../../examples/job-scout/", import.meta.url));
const FLOW_PATTERNS = fileURLToPath(
  new URL("../../../../examples/flow-patterns/", import.meta.url),
);

describe("#268 AC4: agboss describe on job-scout", () => {
  it("the whole application, as printed (snapshot)", async () => {
    const call = await agboss(["describe"], JOB_SCOUT);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    // the config hash depends on where the project is checked out: its format is checked, not its value
    expect(call.stdout).toMatch(/^job-scout-workflow 3\.0\.0 · config [0-9a-f]{8}$/m);
    const printed = call.stdout.replace(/ · config [0-9a-f]{8}$/gm, " · config <hash>");
    await expect(printed).toMatchFileSnapshot("./__snapshots__/job-scout.describe.txt");
  });

  it("--json: the application's tree, implementations, model providers, channels and budgets", async () => {
    const call = await agboss(["describe", "--json"], JOB_SCOUT);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        application: {
          name: "job-scout-application",
          maxConcurrentSteps: null,
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
              tools: ["save-shortlist-tool (job-scout-workflow)"],
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

describe("#268 AC4: agboss describe on flow-patterns — what the public surface says of a workflow", () => {
  it("the review loop's paths and inputs by producer; a model router by its model, a code router as code", async () => {
    const call = await agboss(["describe"], FLOW_PATTERNS);
    const lines = call.stdout.split("\n");

    expect(call.code).toBe(0);
    expect(lines).toEqual(
      expect.arrayContaining([
        "  start(OfferWorkflowStart)",
        "  agent(ReviewerAgent)",
        "  reviewer-agent ← draft: draft-agent | editor-agent (latest, historyOf, limit 1)",
        "    .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))",
        "      caseOf(ChangesRequestedDto, { about: OfferDraftDto })",
        "  reviewer-agent → ChangesRequestedDto { about: OfferDraftDto }",
        "  desk-router  decisions typesafe/jev-1.13 (own) · maxVisits 1 — Sends an order to the intake, ends on anything else",
        "  credit-limit-router  code — Sends large orders for approval, charges the rest",
      ]),
    );
  });
});

const HASH = expect.stringMatching(/^[0-9a-f]{64}$/);

describe("#268 S93: agboss describe --json is the declarative snapshot the records join", () => {
  it("each workflow: its configHash, starts, finishes, nodes with their hashes, edges, onError, launches", async () => {
    const call = await agboss(["describe", "--json"], FLOW_PATTERNS);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        workflows: expect.arrayContaining([
          expect.objectContaining({
            name: "offer-workflow",
            configHash: HASH,
            starts: ["offer-workflow-start"],
            finishes: ["offer-failed-workflow-finish", "offer-sent-workflow-finish"],
            nodes: expect.arrayContaining([
              expect.objectContaining({
                name: "draft-agent",
                kind: "agent",
                promptHash: HASH,
                schemaHash: HASH,
                input: { fields: { shortlist: { dto: "ShortlistDto", schemaHash: HASH } } },
                output: { dto: "OfferDraftDto", schemaHash: HASH },
                agent: expect.objectContaining({
                  model: "moonshotai/kimi-k2.6",
                  provider: "openrouter-model-provider",
                  maxToolCalls: 20,
                  guardrails: { input: [], output: [] },
                  instructions: expect.stringContaining("job offer"),
                }),
              }),
            ]),
            edges: expect.arrayContaining([
              {
                from: "draft-agent",
                to: "reviewer-agent",
                kind: "next",
                writes: [{ value: "OfferDraftDto" }],
              },
            ]),
            onError: [
              {
                at: "editor-agent",
                error: "VisitsLimitExceededError",
                by: "notify-recruiter-action",
                kind: "error",
              },
            ],
          }),
          expect.objectContaining({
            name: "panel-workflow",
            launches: [
              expect.objectContaining({
                launcher: "panel-workflow-start",
                quorum: { kind: "count", min: 2, max: 3, deadline: 30_000 },
                acceptedBy: [
                  [{ name: "in-range-arbiter", kind: "arbiter", decidedBy: "code" }],
                  [expect.objectContaining({ decidedBy: "model", promptHash: HASH })],
                ],
              }),
            ],
          }),
        ]),
      },
    });
  });

  it("schemas: every DTO by class and every tool by name, each with its hash and JSON Schema", async () => {
    const call = await agboss(["describe", "--json"], FLOW_PATTERNS);
    const offsite = expect.objectContaining({
      name: "offsite-booking-workflow",
      schemas: {
        dtos: expect.objectContaining({
          WorkflowStartTextDto: {
            schemaHash: HASH,
            jsonSchema: expect.objectContaining({ type: "object" }),
          },
        }),
        tools: {
          "place-purchase-tool": {
            promptHash: HASH,
            schemaHash: HASH,
            maxResultSize: 131_072, // #336: the built-in, in bytes
            input: expect.objectContaining({ required: ["item", "amountUsd"] }),
            output: expect.objectContaining({ type: "object" }),
          },
        },
      },
    });

    expect(envelope(call)).toMatchObject({
      result: { workflows: expect.arrayContaining([offsite]) },
    });
  });
});
