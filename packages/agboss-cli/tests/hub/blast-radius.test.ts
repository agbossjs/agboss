/**
 * #401 PR 7 — Blast Radius & Federation: the contracts each snapshot declares, drawn as edges
 * consumer → producer (a producer outside the inputs dangling), the problems `agboss check
 * --federation` reports between the snapshots — the same function, so the same problems — each with
 * its blast radius, and who calls an application whose latest eval run lost pass^k.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agboss, envelope, fixture } from "../cli/agboss.js";
import { BILLING, evalRunOf, hubFolder, SHOP } from "./hub-files.js";

interface Problem {
  readonly code: string;
  readonly message: string;
  readonly blastRadius: readonly unknown[];
}

interface FederationResult {
  readonly edges: { readonly declared: readonly Record<string, unknown>[] };
  readonly federation: {
    readonly problems: readonly Problem[];
    readonly undeclared: readonly string[];
    readonly unstableReach: readonly {
      application: string;
      suites: readonly string[];
      consumers: readonly Record<string, unknown>[];
    }[];
  };
}

const showOf = async (cwd: string): Promise<FederationResult> => {
  const call = await agboss(["hub", "show", "hub", "--html", "mesh.html", "--json"], cwd);
  expect(call.code).toBe(0);
  return (envelope(call) as { result: FederationResult }).result;
};

const BILLING_CONTRACT = {
  from: SHOP,
  to: BILLING,
  kind: "a2a",
  contract: "billing-desk-a2a-agent",
  target: "billing-workflow-start",
  usedBy: [{ workflow: "quote-workflow", tool: "ask-billing-tool" }],
  isDangling: false,
};

describe("#401 PR 7: declared edges and the blast radius", () => {
  it("compatible snapshots: every declared contract an edge, a producer outside the inputs dangling", async () => {
    const cwd = await hubFolder();

    const result = await showOf(cwd);

    expect(result.edges.declared).toEqual([
      { ...BILLING_CONTRACT, problems: [] },
      {
        from: SHOP,
        to: "kb-application",
        kind: "mcp",
        contract: "kb.search",
        target: "kb-mcp-expose",
        usedBy: [{ workflow: "kb-workflow", tool: "search-kb-tool" }],
        isDangling: true,
        problems: [],
      },
    ]);
    expect(result.federation.problems).toEqual([]);
    expect(result.federation.undeclared).toEqual([]);
    const page = readFileSync(join(cwd, "mesh.html"), "utf8");
    expect(page).toContain("Blast radius &amp; federation");
    expect(page).toContain("producer not among the inputs");
    expect(page).toContain("1 call · declared");
    expect(page).toContain("mesh-edge mesh-edge-declared");
  });

  it("a contract changed under its consumer: check --federation's own problems, with their blast radius", async () => {
    const cwd = await hubFolder("changed");

    const result = await showOf(cwd);
    const check = await agboss(
      [
        "check",
        "--federation",
        join("hub", "shop", "describe.json"),
        "--application",
        fixture("../federation/fixtures/changed-billing.workflow.ts"),
        "--json",
      ],
      cwd,
    );

    expect(result.edges.declared[0]).toEqual({
      ...BILLING_CONTRACT,
      problems: ["federation.incompatible-schema"],
    });
    const checked = (envelope(check).result as { problems: readonly Problem[] }).problems;
    expect(
      result.federation.problems.map(({ code, blastRadius }) => ({ code, blastRadius })),
    ).toEqual(checked.map(({ code, blastRadius }) => ({ code, blastRadius })));
    result.federation.problems.forEach((problem, index) => {
      expect(checked[index]?.message).toContain(problem.message);
    });
    expect(result.federation.problems[0]?.blastRadius).toEqual([
      { application: SHOP, workflow: "quote-workflow", tool: "ask-billing-tool" },
    ]);
    const page = readFileSync(join(cwd, "mesh.html"), "utf8");
    expect(page).toContain("[federation.incompatible-schema]");
    expect(page).toContain("blast radius: shop-kb-application › quote-workflow · ask-billing-tool");
    expect(page).toContain("1 call · incompatible");
    expect(page).toContain('class="federation-broken"');
  });

  it("a producer losing pass^k reaches its callers, declared and observed", async () => {
    const cwd = await hubFolder();
    writeFileSync(
      join(cwd, "hub", "billing", "billing.run.json"),
      JSON.stringify(evalRunOf(BILLING, "billing-workflow")),
    );

    const result = await showOf(cwd);

    expect(result.federation.unstableReach).toEqual([
      {
        application: BILLING,
        suites: ["refunds-eval-suite"],
        consumers: [
          {
            application: SHOP,
            workflows: ["quote-workflow"],
            tools: ["ask-billing-tool"],
            via: "declared",
          },
          {
            application: SHOP,
            workflows: ["quote-workflow"],
            tools: ["ask-billing-tool"],
            via: "observed",
          },
        ],
      },
      { application: SHOP, suites: ["refunds-eval-suite"], consumers: [] },
    ]);
    expect(readFileSync(join(cwd, "mesh.html"), "utf8")).toContain(
      "shop-kb-application (declared: quote-workflow); shop-kb-application (observed: quote-workflow)",
    );
  });

  it("a snapshot without contracts this agboss reads is named, not guessed", async () => {
    const cwd = await hubFolder();
    const path = join(cwd, "hub", "billing", "describe.json");
    const described = JSON.parse(readFileSync(path, "utf8")) as {
      result: { application: Record<string, unknown> };
    };
    delete described.result.application.contracts;
    writeFileSync(path, JSON.stringify(described));

    const result = await showOf(cwd);

    expect(result.federation.undeclared).toEqual([BILLING]);
    expect(result.edges.declared.map((edge) => edge.isDangling)).toEqual([false, true]);
  });
});
