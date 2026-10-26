/**
 * #397 PR 4 — labels from `agboss eval ui`: a form per judge verdict on each run's page, a label
 * saved to the suite's C4 file (`eval/labels/<suite>.jsonl`, #396 PR 4's format) — replaced for the
 * same run, judge and labeler — the calibration recomputed from it on the next load, and every
 * form that does not come from the page, with the token, refused.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckStatus, type EvalRunResult } from "@agboss/core/eval";
import { respondTo, type EvalUiRequest, type EvalUiSettings } from "../../src/eval/ui/ui-routes.js";
import { artifactOf, caseOf } from "../eval-html/artifacts.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

const judgedRun = (run: number, passed: boolean, executionId: string): EvalRunResult => ({
  run,
  threadId: `thread-${executionId}`,
  executionId,
  finish: "refund-workflow-finish",
  passed,
  checks: [
    { check: "trajectory", status: CheckStatus.Passed },
    {
      check: "answer-grounded-judge",
      status: passed ? CheckStatus.Passed : CheckStatus.Failed,
      ...(passed ? {} : { reason: "not grounded" }),
      metrics: { tone: passed ? "warm" : "cold" },
    },
  ],
  spentUsd: 0.01,
});

const ARTIFACT = artifactOf(
  [caseOf("refund-within-policy", [judgedRun(1, true, "e-1"), judgedRun(2, false, "e-2")])],
  2,
);

/** A fresh folder with the run, its labels folder and a taxonomy. */
function settingsOf(): EvalUiSettings {
  const folder = mkdtempSync(join(tmpdir(), "agboss-eval-labels-"));
  writeFileSync(join(folder, "run.json"), JSON.stringify(ARTIFACT));
  return {
    folder,
    token: TOKEN,
    port: 4317,
    labelsFolder: join(folder, "eval", "labels"),
    tags: [
      { tag: "missed-policy", description: "answered without check_policy" },
      { tag: "invents-fee", description: "a fee no tool returned" },
    ],
    labeler: "anna",
    golden: { kind: "off", reason: "no application here" },
  };
}

const send = (settings: EvalUiSettings, request: Partial<EvalUiRequest>) =>
  respondTo({ method: "GET", url: "/", host: "127.0.0.1:4317", ...request }, settings);

const form = (fields: Readonly<Record<string, string | readonly string[]>>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields))
    for (const each of typeof value === "string" ? [value] : value) params.append(name, each);
  return params.toString();
};

const LABEL = {
  token: TOKEN,
  runId: "refund-within-policy#2",
  executionId: "e-2",
  judge: "answer-grounded-judge",
  labeler: "anna",
  passed: "true",
  score: "3",
  failureTags: ["missed-policy"],
  note: "fine after all",
};

const post = (
  settings: EvalUiSettings,
  fields: Readonly<Record<string, string | readonly string[]>>,
  extra: Partial<EvalUiRequest> = {},
) =>
  send(settings, {
    method: "POST",
    url: "/runs/run.json/labels",
    origin: "http://127.0.0.1:4317",
    body: form(fields),
    ...extra,
  });

const labelsOf = (settings: EvalUiSettings): string =>
  readFileSync(join(settings.labelsFolder, "refunds-eval-suite.jsonl"), "utf8");

describe("#397 PR 4: a run's page has a form per judge verdict", () => {
  it("each with the token, the run, the judge, the labeler, the taxonomy's tags; forms post to the page's own server", async () => {
    const page = await send(settingsOf(), { url: `/runs/run.json?token=${TOKEN}` });

    expect(page.headers["Content-Security-Policy"]).toContain("form-action 'self'");
    expect(page.body).toContain(
      '<form method="post" action="/runs/run.json/labels" class="label-form">',
    );
    expect(page.body).toContain(`<input type="hidden" name="token" value="${TOKEN}">`);
    expect(page.body).toContain(
      '<input type="hidden" name="runId" value="refund-within-policy#2">',
    );
    expect(page.body).toContain('name="labeler" id="label-1-2-1-labeler" value="anna" required');
    expect(page.body).toContain(
      '<span title="a fee no tool returned"><label class="choice" for="label-1-2-1-tag-1"><input type="checkbox" name="failureTags" value="invents-fee"',
    );
    expect(page.body.match(/<form /gu)).toHaveLength(2); // the trajectory is no judge
    expect(page.body).toContain("No label of this run&#39;s judges yet");
  });
});

describe("#397 PR 4: a label saved", () => {
  it("goes to the suite's labels file as #396 PR 4 reads it, then back to the run", async () => {
    const settings = settingsOf();

    const answer = await post(settings, LABEL);

    expect(answer.status).toBe(303);
    expect(answer.headers.Location).toBe(`/runs/run.json?token=${TOKEN}#case-1-run-2`);
    expect(JSON.parse(labelsOf(settings))).toEqual({
      runId: "refund-within-policy#2",
      executionId: "e-2",
      judge: "answer-grounded-judge",
      labeler: "anna",
      passed: true,
      score: 3,
      failureTags: ["missed-policy"],
      note: "fine after all",
    });
  });

  it("the same labeler's label of the same verdict is replaced; another labeler's is added — κ follows", async () => {
    const settings = settingsOf();
    await post(settings, LABEL);
    await post(settings, {
      ...LABEL,
      passed: "false",
      note: "no, it invents a fee",
      failureTags: ["invents-fee"],
    });
    await post(settings, {
      ...LABEL,
      runId: "refund-within-policy#1",
      executionId: "e-1",
      passed: "true",
      failureTags: [],
    });
    await post(settings, { ...LABEL, labeler: "boris", passed: "true", failureTags: [] });

    const lines = labelsOf(settings).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      labeler: "anna",
      passed: false,
      note: "no, it invents a fee",
    });
    const page = (await send(settings, { url: `/runs/run.json?token=${TOKEN}` })).body;
    expect(page).toContain("Calibration against people&#39;s labels");
    expect(page).toContain("3 of 3 label(s)");
    expect(page).toContain(
      '<th scope="row">answer-grounded-judge (judge) · anna</th><td class="number">2</td><td class="number">100%</td>',
    );
    expect(page).toContain("refund-within-policy#2: the judge failed it, boris did not");
    expect(page).toContain("anna: failed · score 3 · invents-fee · no, it invents a fee");
  });
});

describe("#397 PR 4: forms that are refused", () => {
  it("no token in the form, or another origin: 403, nothing written", async () => {
    const settings = settingsOf();
    const { token, ...withoutToken } = LABEL;

    expect(
      (await post(settings, withoutToken, { url: `/runs/run.json/labels?token=${token}` })).status,
    ).toBe(403);
    expect((await post(settings, LABEL, { origin: "https://evil.example" })).status).toBe(403);
    expect(existsSync(settings.labelsFolder)).toBe(false);
  });

  it.each([
    ["no verdict", { passed: "" }, "not a label: passed"],
    ["a score outside 1–4", { score: "7" }, "not a label: score"],
    ["a tag the taxonomy lacks", { failureTags: ["made-up"] }, "not tags of the taxonomy: made-up"],
    [
      "a judge the run has no verdict of",
      { judge: "polite-judge" },
      "has no verdict of polite-judge on refund-within-policy#2",
    ],
    [
      "a run named for another execution",
      { runId: "refund-within-policy#1" },
      "names run refund-within-policy#1, but e-2 is refund-within-policy#2",
    ],
  ])("%s: 400", async (_what, change, message) => {
    const answer = await post(settingsOf(), { ...LABEL, ...change });

    expect(answer.status).toBe(400);
    expect(answer.body).toContain(message);
  });

  it("a labels file that does not read is never rewritten: 409", async () => {
    const settings = settingsOf();
    mkdirSync(settings.labelsFolder, { recursive: true });
    const file = join(settings.labelsFolder, "refunds-eval-suite.jsonl");
    writeFileSync(file, "{ broken\n");

    const answer = await post(settings, LABEL);

    expect(answer.status).toBe(409);
    expect(readFileSync(file, "utf8")).toBe("{ broken\n");
  });

  it("posting elsewhere: 404", async () => {
    expect((await post(settingsOf(), LABEL, { url: "/runs/run.json/elsewhere" })).status).toBe(404);
    expect((await post(settingsOf(), LABEL, { url: "/runs/missing.json/labels" })).status).toBe(
      404,
    );
  });
});
