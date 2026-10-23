/**
 * #401 PR 3 — `agboss hub show <path…> [--html <file>]`: snapshots, eval runs and exported
 * executions read from files and folders by their markers, the mesh of their applications with the
 * calls between them (each counted once, seen from both sides), their health from records and
 * evals, and one self-contained page. A file of another kind is `hub.input-schema`.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { agboss, envelope } from "../cli/agboss.js";
import { BILLING, hubFolder, SHOP } from "./hub-files.js";

let cwd = "";

beforeAll(async () => {
  cwd = await hubFolder();
});

interface ShowResult {
  readonly applications: readonly { name: string; version: string; file: string }[];
  readonly inputs: { describe: number; evalRuns: number; records: number };
  readonly edges: { observed: readonly Record<string, unknown>[] };
  readonly report: string;
}

describe("#401 PR 3: agboss hub show", () => {
  it("every kind of input by its marker: the applications, the calls between them once, a page", async () => {
    const call = await agboss(["hub", "show", "hub", "--html", "mesh.html", "--json"], cwd);

    expect(call.code).toBe(0);
    const result = (envelope(call) as { result: ShowResult }).result;
    expect(result.applications.map(({ name }) => name).sort()).toEqual([BILLING, SHOP]);
    expect(result.inputs).toMatchObject({ describe: 2, evalRuns: 1, records: 3 });
    expect(result.edges.observed).toEqual([
      {
        from: SHOP,
        to: BILLING,
        calls: 1,
        workflows: ["quote-workflow"],
        tools: ["ask-billing-tool"],
      },
    ]);
    expect(call.stderr).toContain("hub: 2 applications");
    expect(call.stderr).toContain("1 observed cross-service edge");
    const page = readFileSync(join(cwd, "mesh.html"), "utf8");
    expect(page).toContain('content="agboss hub"');
    expect(page).toContain('content="default-src &#39;none&#39;; style-src &#39;sha256-');
    expect(page).not.toMatch(/<script src|<link |@import|url\(http/u);
    expect(page).toContain("<svg");
    expect(page).toContain("quote-workflow");
    expect(page).toContain("billing-workflow");
    expect(page).toContain("limit.budget");
    expect(page).toContain("refunds-eval-suite");
    expect(page).toContain("1/3 (33%)");
  });

  it("without --html: the summary only; a file given directly is read whatever its folder", async () => {
    const call = await agboss(["hub", "show", join("hub", "billing", "describe.json")], cwd);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      "hub: 1 application · 1 workflow · 0 observed cross-service edges",
    );
    expect(call.stdout).toContain("snapshots 1 · eval runs 0 · kept executions 0");
  });

  it("a file of no kind it reads, a newer schema, a bad line, a twice-described version fail", async () => {
    writeFileSync(join(cwd, "labels.json"), JSON.stringify({ kind: "agboss.labels" }));
    const describe = JSON.parse(
      readFileSync(join(cwd, "hub", "shop", "describe.json"), "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(join(cwd, "newer.json"), JSON.stringify({ ...describe, schema: 2 }));
    writeFileSync(
      join(cwd, "bad.jsonl"),
      `${readFileSync(join(cwd, "hub", "billing", "records", "week.jsonl"), "utf8")}{"kind":"agboss.execution-record","schema":1}\n`,
    );
    copyFileSync(join(cwd, "hub", "shop", "describe.json"), join(cwd, "copy.json"));

    const unknown = await agboss(["hub", "show", "labels.json", "--json"], cwd);
    const newer = await agboss(["hub", "show", "newer.json", "--json"], cwd);
    const badLine = await agboss(["hub", "show", "bad.jsonl", "--json"], cwd);
    const twice = await agboss(["hub", "show", "hub", "copy.json", "--json"], cwd);
    const missing = await agboss(["hub", "show", "nowhere", "--json"], cwd);
    const none = await agboss(["hub", "show", "--json"], cwd);

    expect([unknown, newer, badLine, twice, missing, none].map(({ code }) => code)).toEqual([
      3, 3, 3, 3, 3, 2,
    ]);
    expect(envelope(unknown)).toMatchObject({
      error: {
        code: "hub.input-schema",
        message: expect.stringContaining("labels.json: not a describe --json envelope") as unknown,
      },
    });
    expect(envelope(unknown)).toMatchObject({
      error: { message: expect.stringContaining('(kind "agboss.labels")') as unknown },
    });
    expect(envelope(newer)).toMatchObject({
      error: {
        code: "hub.input-schema",
        message: expect.stringContaining("schema 2 is not one this agboss reads") as unknown,
      },
    });
    expect(envelope(badLine)).toMatchObject({
      error: {
        code: "hub.input-schema",
        message: expect.stringContaining(
          "bad.jsonl: line 2.executionId is not a string",
        ) as unknown,
      },
    });
    expect(envelope(twice)).toMatchObject({
      error: {
        code: "hub.duplicate-application",
        message: expect.stringContaining(`${SHOP} 1.0.0 is described twice`) as unknown,
      },
    });
    expect(envelope(missing)).toMatchObject({ error: { code: "hub.input-not-found" } });
    expect(envelope(none)).toMatchObject({ error: { code: "usage.missing-argument" } });
  });
});
