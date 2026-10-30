/**
 * #268 AC4 — `agboss describe` as printed (M1), on flow-patterns' desk application since job-scout
 * left the repository (#489 AC2): the tree with its start, each contract's implementation and why
 * (listed SQLite stores beside built-in defaults), the transport model provider, the budgets by
 * scope, the observers and `maxConcurrentSteps`, the environment with its secrets masked, then the
 * workflow — its guardrails, tool interceptors, PII policies and compaction, flow, inputs with their
 * producers, limits with the worst case, `model → provider`. The patterns' own application gives the
 * built-in model providers and the channels a tool names. No API key, no network (the config hash,
 * which depends on the checkout, is masked). A change to the desk or to describe updates the
 * snapshot (`npx vitest run -u`), reviewed like code.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agboss, envelope } from "./agboss.js";

const FLOW_PATTERNS = fileURLToPath(
  new URL("../../../../examples/flow-patterns/", import.meta.url),
);
const DESK = ["--application", "src/desk.application.ts"];

describe("#489 AC2: #268 AC4 agboss describe on flow-patterns' desk application", () => {
  it("the whole application, as printed (snapshot)", async () => {
    const call = await agboss(["describe", ...DESK], FLOW_PATTERNS);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    // the config hash depends on where the project is checked out: its format is checked, not its value
    expect(call.stdout).toMatch(/^desk-workflow 1\.0\.0 · config [0-9a-f]{8}$/m);
    const printed = call.stdout.replace(/ · config [0-9a-f]{8}$/gm, " · config <hash>");
    await expect(printed).toMatchFileSnapshot("./__snapshots__/flow-patterns-desk.describe.txt");
  });

  it("--json: the application's tree, its transport model provider, budgets and PII policies", async () => {
    const call = await agboss(["describe", "--json", ...DESK], FLOW_PATTERNS);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        application: {
          name: "desk-application",
          maxConcurrentSteps: 16,
          tree: [
            {
              name: "desk-workflow",
              starts: ["desk-workflow-start (DeskQuestionDto)"],
              children: [],
            },
          ],
          modelProviders: [
            { name: "harness-model-provider", className: "HarnessModelProvider", isTransport: true },
          ],
          channels: [],
          executionBudgets: [{ workflow: "desk-workflow", name: "execution-budget", isOwn: false }],
        },
        workflows: [
          {
            name: "desk-workflow",
            piiPolicies: [{ name: "customer-id-pii-policy", elements: ["desk-agent"] }],
          },
        ],
      },
    });
  });

  it("--json on the patterns' application: the built-in model providers and the channels tools name", async () => {
    const call = await agboss(["describe", "--json"], FLOW_PATTERNS);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        application: {
          name: "flow-patterns-application",
          modelProviders: expect.arrayContaining([
            { name: "openrouter-model-provider", className: "OpenRouterModelProvider" },
            { name: "decisions-model-provider", className: "DecisionsModelProvider" },
          ].map((provider) => expect.objectContaining(provider) as unknown)),
          channels: [
            expect.objectContaining({
              name: "purchase-approval-channel",
              question: "PurchaseOrder",
              answer: "ToolCallApprovalDecisionDto",
              implementation: "TerminalPurchaseApprovalChannel",
              tools: ["place-purchase-tool (offsite-booking-workflow)"],
            }),
            expect.objectContaining({
              name: "recruiter-approval-channel",
              implementation: "RecruiterInboxChannel",
              tools: ["send-offer-letter-tool (send-offer-workflow)"],
            }),
          ],
        },
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
