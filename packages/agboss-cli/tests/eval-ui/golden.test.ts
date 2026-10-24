/**
 * #397 PR 5 — "save as golden case" in `agboss eval ui` (S2 Q5): a run's kept execution drafted
 * the way `agboss generate eval-case --from-execution` drafts it (#396 PR 8, one builder) and
 * written into the suite's file — whole, only while the file is the page's (its ETag), never over a
 * case of the same name — behind the token in the form, the Origin and the Host; and, when the
 * application keeps no execution records, the page says so instead of a button.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckStatus, type EvalRunResult } from "agboss/eval";
import { openExecutionHistory, type OpenedExecutionHistory } from "agboss/internal";
import { SqliteHistoryApplication } from "../../../agboss/tests/infrastructure/sqlite/fixtures/history.application.js";
import {
  historyRecordOf,
  REFUND_THREAD,
} from "../../../agboss/tests/eval/fixtures/history-records.js";
import type { CommandContext } from "../../src/cli/context.js";
import { etagOf, type GoldenSource } from "../../src/eval/ui/golden-case.js";
import { goldenSourceOf } from "../../src/eval/ui/golden-source.js";
import { respondTo, type EvalUiRequest, type EvalUiSettings } from "../../src/eval/ui/ui-routes.js";
import { artifactOf, caseOf } from "../eval-html/artifacts.js";

/** The framework's package: the fixtures' project, read only. */
const PACKAGE = new URL("../../../agboss/", import.meta.url).pathname;
const APPLICATION = "tests/infrastructure/sqlite/fixtures/history.application.ts";
const SUITE_FILE = "tests/infrastructure/sqlite/fixtures/eval-suites/refunds.eval-suite.ts";
const TOKEN = "0123456789abcdef0123456789abcdef";

const FOLDER = mkdtempSync(join(tmpdir(), "agboss-eval-golden-"));
const ENV = { AGBOSS_SQLITE_TEST_PATH: join(FOLDER, "app.db") };
let opened: OpenedExecutionHistory;

beforeAll(async () => {
  opened = await openExecutionHistory(SqliteHistoryApplication, { processEnv: ENV });
  for (const record of REFUND_THREAD) await opened.history.save(record);
  await opened.history.save(historyRecordOf("e1", { tenantId: "globex" })); // e1 of another tenant too
});

afterAll(async () => {
  await opened.close();
  rmSync(FOLDER, { recursive: true, force: true });
});

const ranRun = (
  run: number,
  executionId: string | undefined,
  tenantId: string | null = "acme",
): EvalRunResult => ({
  run,
  threadId: "thread-1",
  ...(tenantId === null ? {} : { tenantId }),
  ...(executionId === undefined ? {} : { executionId }),
  finish: "desk-workflow-finish",
  passed: true,
  checks: [{ check: "trajectory", status: CheckStatus.Passed }],
  spentUsd: 0.01,
});

const ARTIFACT = artifactOf(
  [
    caseOf("refund-order-7", [ranRun(1, "e1"), ranRun(2, "nowhere")]),
    caseOf("refund-before-tenants", [ranRun(1, "e1", null)]), // a schemaVersion 3 run: no tenant
  ],
  2,
);

/** A copy of the fixtures' project — the suite's file is written — and a run of its suite. */
function projectOf(): string {
  const root = mkdtempSync(join(FOLDER, "project-"));
  for (const folder of ["tests/infrastructure/sqlite/fixtures", "tests/flow/fixtures"])
    cpSync(join(PACKAGE, folder), join(root, folder), { recursive: true });
  mkdirSync(join(root, "src")); // what the fixtures import from the framework: none of it read
  writeFileSync(join(root, "run.json"), JSON.stringify(ARTIFACT));
  return root;
}

const settingsOf = (root: string, golden?: GoldenSource): EvalUiSettings => ({
  folder: root,
  token: TOKEN,
  port: 4317,
  labelsFolder: join(root, "eval", "labels"),
  tags: undefined,
  labeler: "anna",
  golden: golden ?? { kind: "kept", root, application: APPLICATION, history: opened.history },
});

const send = (settings: EvalUiSettings, request: Partial<EvalUiRequest>) =>
  respondTo({ method: "GET", url: "/", host: "127.0.0.1:4317", ...request }, settings);

const pageOf = async (settings: EvalUiSettings, query = ""): Promise<string> =>
  (await send(settings, { url: `/runs/run.json?token=${TOKEN}${query}` })).body;

const suiteOf = (root: string): string => readFileSync(join(root, SUITE_FILE), "utf8");

const post = (settings: EvalUiSettings, fields: Readonly<Record<string, string>>, extra = {}) =>
  send(settings, {
    method: "POST",
    url: "/runs/run.json/golden",
    origin: "http://127.0.0.1:4317",
    body: new URLSearchParams(fields).toString(),
    ...extra,
  });

const formOf = (root: string, fields: Readonly<Record<string, string>> = {}) => ({
  token: TOKEN,
  executionId: "e1",
  run: "refund-order-7#1",
  etag: etagOf(suiteOf(root)),
  name: "refund-from-run-1",
  ...fields,
});

describe("#397 PR 5: a run's page offers to save its execution as a golden case", () => {
  it("a form per run with an execution: the token, the execution, the suite file's ETag, a name", async () => {
    const root = projectOf();

    const page = await pageOf(settingsOf(root));

    expect(page).toContain(
      '<form method="post" action="/runs/run.json/golden" class="label-form golden">',
    );
    expect(page).toContain('<input type="hidden" name="executionId" value="e1">');
    expect(page).toContain(`<input type="hidden" name="etag" value="${etagOf(suiteOf(root))}">`);
    expect(page).toContain(`as a case of refunds-eval-suite (${SUITE_FILE}), named`);
    expect(page).toContain('value="refund-order-7-run-1" required maxlength="120"');
    expect(page.match(/class="label-form golden"/gu)).toHaveLength(3);
  });

  it("no execution records kept: the page says why instead of a button; a POST is refused", async () => {
    const root = projectOf();
    const settings = settingsOf(root, { kind: "off", reason: "keeps no execution records" });

    expect(await pageOf(settings)).toContain(
      '<p class="muted golden">Save as golden case: keeps no execution records</p>',
    );
    const answer = await post(settings, formOf(root));
    expect(answer.status).toBe(409);
    expect(answer.body).toContain("keeps no execution records");
  });

  it("a suite the project does not have: the reason, no form", async () => {
    const root = projectOf();
    const other = { ...ARTIFACT, suite: "missing-eval-suite" };
    writeFileSync(join(root, "run.json"), JSON.stringify(other));

    const page = await pageOf(settingsOf(root));

    expect(page).toContain(
      "Save as golden case: no eval suite named &quot;missing-eval-suite&quot;",
    );
    expect(page).not.toContain('class="label-form golden"');
  });
});

describe("#397 PR 5: a golden case saved", () => {
  it("goes into the suite's file as generate eval-case drafts it, then back to the run with a notice", async () => {
    const root = projectOf();
    const settings = settingsOf(root);

    const answer = await post(settings, formOf(root));

    expect(answer.status).toBe(303);
    expect(answer.headers.Location).toBe(
      `/runs/run.json?token=${TOKEN}&saved=refund-from-run-1#case-1-run-1`,
    );
    const suite = suiteOf(root);
    expect(suite).toContain('evalCase({ name: "refund-from-run-1", tenant: {"tenantId":"acme"');
    expect(suite).toContain('turns: [turn({"text":"Refund order 7 for <email>"})]');
    expect(suite).toContain('name: "refund-order-7"'); // the case it had stays
    expect(readdirSync(join(root, "tests/infrastructure/sqlite/fixtures/eval-suites"))).toEqual([
      "refunds.eval-suite.ts",
    ]); // no temporary file left
    expect(await pageOf(settings, "&saved=refund-from-run-1")).toContain(
      '<p class="notice" role="status">Saved as the case &quot;refund-from-run-1&quot; of refunds-eval-suite.</p>',
    );
  });

  it("a case of that name already: 409, the file as it was", async () => {
    const root = projectOf();
    const before = suiteOf(root);

    const answer = await post(settingsOf(root), formOf(root, { name: "refund-order-7" }));

    expect(answer.status).toBe(409);
    expect(answer.body).toContain("refund-order-7");
    expect(suiteOf(root)).toBe(before);
  });

  it("an execution two tenants kept: the run's own tenant's (#397 PR 5b)", async () => {
    const root = projectOf();

    expect((await post(settingsOf(root), formOf(root))).status).toBe(303);
    expect(suiteOf(root)).toContain(
      'evalCase({ name: "refund-from-run-1", tenant: {"tenantId":"acme"',
    );
  });

  it("a run recorded before runs carried their tenant: 409 in the page's words, no CLI option", async () => {
    const root = projectOf();
    const before = suiteOf(root);

    const answer = await post(settingsOf(root), formOf(root, { run: "refund-before-tenants#1" }));

    expect(answer.status).toBe(409);
    expect(answer.body.trimEnd()).toBe(
      "the execution e1 of this run is kept for several tenants (acme, globex), and this run was recorded before runs carried their tenant: run the suite again and save from the new run",
    );
    expect(answer.body).not.toContain("--");
    expect(suiteOf(root)).toBe(before);
  });

  it("the file changed since the page was made: 409 — reload; saving twice from one page is too", async () => {
    const root = projectOf();
    const settings = settingsOf(root);
    const form = formOf(root);

    expect((await post(settings, form)).status).toBe(303);
    const after = suiteOf(root);
    const again = await post(settings, { ...form, name: "refund-from-run-1-again" });

    expect(again.status).toBe(409);
    expect(again.body).toContain(`${SUITE_FILE} changed since this page was made`);
    expect(suiteOf(root)).toBe(after);
  });

  it.each([
    [
      "an execution the history does not have: 404",
      { run: "refund-order-7#2", executionId: "nowhere" },
      404,
      "the execution nowhere of tenant acme on this run's thread is not in the application's history",
    ],
    [
      "a run named for another execution: 400",
      { run: "refund-order-7#2" },
      400,
      "names run refund-order-7#2, but its execution is nowhere, not e1",
    ],
    [
      "a run the report does not have: 400",
      { run: "refund-order-7#9" },
      400,
      "a run of this report",
    ],
    ["no name: 400", { name: " " }, 400, "the form needs a name"],
  ])("%s, nothing written", async (_what, change, status, message) => {
    const root = projectOf();
    const before = suiteOf(root);

    const answer = await post(settingsOf(root), formOf(root, change));

    expect(answer.status).toBe(status);
    expect(answer.body).toContain(message);
    expect(suiteOf(root)).toBe(before);
  });

  it("no token in the form, or another origin: 403, nothing written", async () => {
    const root = projectOf();
    const before = suiteOf(root);
    const { token, ...withoutToken } = formOf(root);

    expect(
      (await post(settingsOf(root), withoutToken, { url: `/runs/run.json/golden?token=${token}` }))
        .status,
    ).toBe(403);
    expect(
      (await post(settingsOf(root), formOf(root), { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(suiteOf(root)).toBe(before);
  });
});

const contextIn = (cwd: string, values: CommandContext["values"]): CommandContext => ({
  command: "eval ui",
  values,
  positionals: [],
  json: false,
  io: { stdout: process.stdout, stderr: process.stderr, env: ENV, cwd, registerTypeScript: false },
  say: () => undefined,
  warn: () => undefined,
});

describe("#397 PR 5: where eval ui reads executions from", () => {
  it("an application that keeps its records: its history", async () => {
    const golden = await goldenSourceOf(contextIn(PACKAGE, { application: APPLICATION }));
    try {
      expect(golden.source).toMatchObject({
        kind: "kept",
        root: PACKAGE,
        application: APPLICATION,
      });
    } finally {
      await golden.close();
    }
  });

  it("one that keeps none, none at all, one that does not load: off, and why", async () => {
    const notKept = await goldenSourceOf(
      contextIn(PACKAGE, { application: "tests/flow/fixtures/evals.fixture.ts" }),
    );
    const none = await goldenSourceOf(contextIn(FOLDER, {}));
    const broken = await goldenSourceOf(
      contextIn(PACKAGE, { application: "tests/flow/fixtures/budgets.ts" }),
    );

    expect(notKept.source).toMatchObject({
      kind: "off",
      reason: expect.stringContaining(
        "keeps no execution records, so a run's execution cannot be read back: set @Application({ executionRecordRetention })",
      ) as unknown,
    });
    expect(none.source).toMatchObject({
      kind: "off",
      reason: expect.stringContaining("no application here") as unknown,
    });
    expect(broken.source).toMatchObject({
      kind: "off",
      reason: expect.stringContaining("the application did not load") as unknown,
    });
  });
});
