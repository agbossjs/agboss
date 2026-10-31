/**
 * #578 — an id the application's own `IdGenerator` mints is held to the key-text rules (#538, #547,
 * #556) at the mint, like every id that comes in: `x\uD800` and `x\uDFFF` are both `x�` in UTF-8, so
 * two trees would share one lease, one lease log, one queue row and one fenced-effect scope. A
 * minted id breaking a rule is `InvalidMintedIdError` — the generator's class, the method and the
 * rule named, never the id — and is never used nor stored.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { InvalidMintedIdError, KeyTextRule, keyTextRuleOf } from "../../src/errors.js";
import { RandomIdGenerator } from "../../src/index.js";
import { replyWith, SequentialIdGenerator, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { execute } from "../helpers/flow.js";
import {
  ChildRefundAgent,
  SingleChildWorkflowStart,
} from "../channels/fixtures/child-pauses.workflow.js";
import { approve, orderOf } from "../channels/fixtures/pause-scripts.js";
import {
  ConfirmOrderTool,
  RefundDoneDto,
  resetPauses,
} from "../channels/fixtures/pauses.workflow.js";
import { callTool, type ModelRequest } from "../../src/testing/index.js";
import { REFUSED_KEYS } from "../app/fixtures/key-texts.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
  resetRecovery,
} from "./fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "./sqlite/fixtures/sqlite.workflow.js";
import { minting, PlannedIdsApplication, resetMinting } from "./fixtures/minted-ids.application.js";
import { SqlitePlannedIdsApplication } from "./sqlite/fixtures/sqlite-minted-ids.application.js";

const file = sqliteFilePerTest();
const sqlite = testWith(SqlitePlannedIdsApplication);
const planned = testWith(PlannedIdsApplication);

beforeEach(() => {
  resetMinting();
  resetPauses();
  resetRecovery();
});

/** What `call` rejected with (`undefined`: it did not). */
const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The error names the generator, the method and the rule — never the id, nor a part of it. */
function expectRefusedMint(error: unknown, method: string, rule: KeyTextRule, id: unknown): void {
  expect(error).toBeInstanceOf(InvalidMintedIdError);
  expect(error).toMatchObject({
    code: "run.invalid-minted-id",
    generator: "PlannedIdGenerator",
    method,
    rule,
  });
  const { message } = error as Error;
  expect(message).toContain("PlannedIdGenerator");
  expect(message).toContain(`${method}()`);
  expect(message).toContain(`(${rule})`);
  if (typeof id === "string" && id.length > 0) expect(message).not.toContain(id);
  expect(JSON.stringify((error as InvalidMintedIdError).details)).not.toContain("x\\ud8");
}

/** The rows of every table of the test's SQLite file. */
function rowsOnFile(): Record<string, number> {
  const database = new DatabaseSync(file.path, { readOnly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => {
        const row = database.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number };
        return [name, row.n];
      }),
    );
  } finally {
    database.close();
  }
}

/** The child's agent: the customer confirms the order first (a pause), then it answers. */
const confirmer = (request: ModelRequest) =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool")
    ? replyWith(RefundDoneDto, { orderId: orderOf(request) })
    : callTool(ConfirmOrderTool, { orderId: orderOf(request) });

describe("#578 AC1: on SQLite, a minted id that is no key fails the execution before anything is stored", () => {
  sqlite(
    "newExecutionId() → x\\uD800, then x\\uDFFF: both refused, nothing on the file; the next valid id runs",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      await app.ready();
      const before = rowsOnFile();
      minting.executions = ["x\uD800", "x\uDFFF"];

      const first = await rejectionOf(execute(app, OrderWorkflowStart, { text: "a" }));
      const second = await rejectionOf(execute(app, OrderWorkflowStart, { text: "b" }));

      expectRefusedMint(first, "newExecutionId", KeyTextRule.LoneSurrogate, "x\uD800");
      expectRefusedMint(second, "newExecutionId", KeyTextRule.LoneSurrogate, "x\uDFFF");
      expect(rowsOnFile()).toEqual(before);
      const done = await execute(app, OrderWorkflowStart, { text: "c" });
      expect(done.status).toBe(ExecutionStatus.Finished);
      expect(done.executionId).toMatch(/^execution-\d+$/);
    },
  );

  sqlite(
    "newThreadId() → x\\uD800: refused before the thread is created — only the execution's kept id (#591) and its admitted budgets' maxSpend() are kept",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      await app.ready();
      const before = rowsOnFile();
      minting.threads = ["x\uD800"];

      const refused = await rejectionOf(execute(app, OrderWorkflowStart, { text: "a" }));

      expectRefusedMint(refused, "newThreadId", KeyTextRule.LoneSurrogate, "x\uD800");
      // a thread is minted once the budgets passed (#262 Q4): their maxSpend() is kept, under the
      // valid execution id, and that id itself (#591: kept first, never handed out again) — no
      // thread, record, lease, checkpoint or tree of the refused id
      const { cost_ledger_max_spend: kept, execution_ids: ids, ...rest } = rowsOnFile();
      const { cost_ledger_max_spend: keptBefore, execution_ids: idsBefore, ...restBefore } = before;
      expect(rest).toEqual(restBefore);
      expect([keptBefore, kept]).toEqual([0, 3]);
      expect([idsBefore, ids]).toEqual([0, 1]);
      const done = await execute(app, OrderWorkflowStart, { text: "b" });
      expect(done.threadId).toMatch(/^thread-\d+$/);
    },
  );

  sqlite(
    "a caller's own threadId mints no thread id: the generator is not asked",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      minting.threads = ["x\uD800"];

      const done = await execute(app, OrderWorkflowStart, { text: "a" }, { threadId: "order-a" });

      expect(done.threadId).toBe("order-a");
      expect(minting.threads).toEqual(["x\uD800"]);
    },
  );
});

describe("#578 AC1: a child's minted execution id", () => {
  planned(
    "x\\uD800 for the child: the launch fails with it in the cause chain, the child never starts",
    async ({ app, mockLlm }) => {
      mockLlm(ChildRefundAgent).thenAnswer(confirmer);
      minting.executions = ["root-1", "x\uD800"];

      const failed = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "A" }));

      expect(failed).toBeInstanceOf(Error);
      expectRefusedMint(causeOf(failed), "newExecutionId", KeyTextRule.LoneSurrogate, "x\uD800");
      expect(mockLlm(ChildRefundAgent).requests).toHaveLength(0);
    },
  );

  planned("a valid child id still pauses and finishes", async ({ app, mockLlm }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);
    minting.executions = ["root-1", "child-1"];

    const paused = await execute(app, SingleChildWorkflowStart, { orderId: "A" });
    const done = await app.resume({ pauseId: paused.pending[0]?.pauseId ?? "", decision: approve });

    expect(paused.pending[0]?.childExecutionId).toBe("child-1");
    expect(done.status).toBe(ExecutionStatus.Finished);
  });
});

/** The `InvalidMintedIdError` in `error`'s cause chain (or `error` itself). */
function causeOf(error: unknown): unknown {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if (at instanceof InvalidMintedIdError) return at;
  }
  return error;
}

describe("#578 AC2: every refused key text of #538 / #547 / #556, at both methods", () => {
  planned.for(REFUSED_KEYS)("newExecutionId() → %s (%s)", async ([, rule, id], { app }) => {
    minting.executions = [id];

    const refused = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "A" }));

    expectRefusedMint(refused, "newExecutionId", rule, id);
  });

  planned.for(REFUSED_KEYS)("newThreadId() → %s (%s)", async ([, rule, id], { app }) => {
    minting.threads = [id];

    const refused = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "A" }));

    expectRefusedMint(refused, "newThreadId", rule, id);
  });

  planned.for([
    ["undefined", undefined],
    ["a number", 42],
    ["null", null],
  ] as const)(
    "a JavaScript generator's %s: refused as no key's length",
    async ([, id], { app }) => {
      minting.executions = [id];

      const refused = await rejectionOf(execute(app, SingleChildWorkflowStart, { orderId: "A" }));

      expectRefusedMint(refused, "newExecutionId", KeyTextRule.Length, id);
    },
  );
});

describe("#578: every part of the framework mints through the checked generator", () => {
  it("the infrastructure's IdGenerator (the eval runner, a workflow run on its own) refuses too", async () => {
    const built = await buildApplication(await applicationOf(PlannedIdsApplication, {}), {
      gateway: createScriptedGateway(new ScriptBook()),
    });
    try {
      minting.threads = ["x\uDFFF"];
      minting.executions = ["x​"];

      expectRefusedMint(
        rejectionSync(() => built.infrastructure.idGenerator.newThreadId()),
        "newThreadId",
        KeyTextRule.LoneSurrogate,
        "x\uDFFF",
      );
      expectRefusedMint(
        rejectionSync(() => built.infrastructure.idGenerator.newExecutionId()),
        "newExecutionId",
        KeyTextRule.FormatCharacter,
        "x​",
      );
    } finally {
      await built.app.close();
    }
  });
});

/** What `call` threw (`undefined`: it did not). */
function rejectionSync(call: () => unknown): unknown {
  try {
    call();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe("#578 AC3: the built-in generators are unaffected", () => {
  it("RandomIdGenerator and SequentialIdGenerator mint keys only", () => {
    const random = new RandomIdGenerator();
    const sequential = new SequentialIdGenerator();
    const ids = Array.from({ length: 500 }, () => [
      random.newThreadId(),
      random.newExecutionId(),
      sequential.newThreadId(),
      sequential.newExecutionId(),
    ]).flat();

    expect(ids.filter((id) => keyTextRuleOf(id) !== undefined)).toEqual([]);
  });
});
