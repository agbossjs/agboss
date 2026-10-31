/**
 * #396 PR 8 — `agboss generate eval-case <name> --from-execution <executionId>`: a kept execution
 * (#401) read from the application's history without running anything and drafted into a case of
 * its suite — the turn, the contexts, the thread's earlier finished turns, the calls it ran — with
 * the classes it names imported. The fixture's suite is never written here: `--dry-run`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openExecutionHistory } from "@agboss/core/internal";
import { SqliteHistoryApplication } from "../../../agboss/tests/infrastructure/sqlite/fixtures/history.application.js";
import {
  historyRecordOf,
  REFUND_THREAD,
} from "../../../agboss/tests/eval/fixtures/history-records.js";
import { agboss, envelope } from "./agboss.js";

/** The framework's package: the fixtures' project root. */
const ROOT = new URL("../../../agboss/", import.meta.url).pathname;
const APPLICATION = "tests/infrastructure/sqlite/fixtures/history.application.ts";
const SUITE_FILE = "tests/infrastructure/sqlite/fixtures/eval-suites/refunds.eval-suite.ts";
const NOT_KEPT = "tests/flow/fixtures/evals.fixture.ts";

const FOLDER = mkdtempSync(join(tmpdir(), "agboss-eval-case-"));
const ENV = { AGBOSS_SQLITE_TEST_PATH: join(FOLDER, "app.db") };
const GENERATE = ["generate", "eval-case", "--application", APPLICATION] as const;

beforeAll(async () => {
  const opened = await openExecutionHistory(SqliteHistoryApplication, { processEnv: ENV });
  for (const record of REFUND_THREAD) await opened.history.save(record);
  await opened.history.save(historyRecordOf("e1", { tenantId: "globex" }));
  await opened.close();
});

afterAll(() => {
  rmSync(FOLDER, { recursive: true, force: true });
});

interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/** The suite's planned content of a `--dry-run --json` call. */
const plannedSuite = (stdout: string): PlannedFile | undefined => {
  const result = (JSON.parse(stdout) as { result: { plan: { modify: PlannedFile[] } } }).result;
  return result.plan.modify.find((file) => file.path === SUITE_FILE);
};

describe("#396 PR 8: agboss generate eval-case --from-execution", () => {
  it("the kept execution drafted into the suite: turn, contexts, history, calls; classes imported", async () => {
    const call = await agboss(
      [
        ...GENERATE,
        "refund-from-prod",
        "--from-execution",
        "e1",
        "--tenant",
        "acme",
        "--dry-run",
        "--json",
      ],
      ROOT,
      ENV,
    );

    expect(call.code).toBe(0);
    const suite = plannedSuite(call.stdout);
    expect(suite?.content).toContain(
      'evalCase({ name: "refund-from-prod", tenant: {"tenantId":"acme","plan":"pro"}, execution: {"userId":"u-1"}, ' +
        'history: [pastTurn(DeskWorkflowStart, {"text":"Where is order 7?"}, DeskWorkflowFinish, {"text":"Order 7 arrived broken."})], ' +
        'turns: [turn({"text":"Refund order 7 for <email>"})], ' +
        'tools: { required: [toolCall(GetOrderTool, {"orderId":"7"}), toolCall(RefundTool, {"orderId":"7","amountCents":5000})] } }),',
    );
    expect(suite?.content).toContain("evalCase,\n  turn, pastTurn, toolCall\n}");
    expect(suite?.content).toContain(
      'import { DeskWorkflowStart, DeskWorkflowFinish, GetOrderTool, RefundTool } from "../../../../flow/fixtures/eval-desk.fixture.js";',
    );
    expect(suite?.content).toContain('name: "refund-order-7"');
  });

  it("#580: a --tenant that is no key's text is refused, exit 2, naming the rule and never the id", async () => {
    const tenant = "acme\u200B";
    const call = await agboss(
      [...GENERATE, "x", "--from-execution", "e1", "--tenant", tenant, "--json"],
      ROOT,
      ENV,
    );

    expect(call.code).toBe(2);
    const { error } = envelope(call) as { error: { code: string; message: string } };
    expect(error).toMatchObject({ code: "usage.option-value" });
    expect(error.message).toContain("format-character");
    expect(`${call.stdout}${call.stderr}`).not.toContain(tenant);
  });

  it("an id two tenants kept needs --tenant; an unknown one, an unkept application, a taken name fail", async () => {
    const ambiguous = await agboss(
      [...GENERATE, "x", "--from-execution", "e1", "--json"],
      ROOT,
      ENV,
    );
    const unknown = await agboss(
      [...GENERATE, "x", "--from-execution", "nope", "--json"],
      ROOT,
      ENV,
    );
    const taken = await agboss(
      [...GENERATE, "refund-order-7", "--from-execution", "e1", "--tenant", "acme", "--json"],
      ROOT,
      ENV,
    );
    const notKept = await agboss(
      ["generate", "eval-case", "x", "--application", NOT_KEPT, "--from-execution", "e1", "--json"],
      ROOT,
    );
    const noExecution = await agboss([...GENERATE, "x", "--json"], ROOT, ENV);
    const unknownSuite = await agboss(
      [
        ...GENERATE,
        "x",
        "--from-execution",
        "e1",
        "--tenant",
        "acme",
        "--suite",
        "refund-eval-suite",
        "--json",
      ],
      ROOT,
      ENV,
    );

    expect([
      ambiguous.code,
      unknown.code,
      taken.code,
      notKept.code,
      noExecution.code,
      unknownSuite.code,
    ]).toEqual([2, 3, 4, 3, 2, 2]);
    expect(envelope(ambiguous)).toMatchObject({
      error: {
        code: "records.ambiguous-execution",
        message: expect.stringContaining("acme, globex") as unknown,
      },
    });
    expect(envelope(unknown)).toMatchObject({ error: { code: "records.not-found" } });
    expect(envelope(taken)).toMatchObject({
      error: {
        message: expect.stringContaining('already has a case named "refund-order-7"') as unknown,
      },
    });
    expect(envelope(notKept)).toMatchObject({ error: { code: "records.not-kept" } });
    expect(envelope(noExecution)).toMatchObject({ error: { code: "usage.missing-option" } });
    expect(envelope(unknownSuite)).toMatchObject({
      error: { message: expect.stringContaining('Did you mean "refunds-eval-suite"?') as unknown },
    });
  });
});
