/**
 * #552 — a tenant id is a key's text too: it keys threads, leases, pauses, budgets and business-key
 * rows, so two ids a person or a database takes for one must never be two tenants, nor two ids that
 * UTF-8 makes one (`t\uD800` and `t\uD801` are both `t�` in SQLite and PostgreSQL) one tenant.
 * Refused at `app.execute`, `app.resume` and `app.cancel` with `dto.invalid`, the field and the rule
 * named, never the id; and `app.cancel`'s thread id is held to the rules `execute`'s is.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/errors.js";
import { InvalidThreadIdError, KeyTextRule } from "../../src/errors.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
} from "../infrastructure/fixtures/recovery.workflow.js";
import {
  SqliteNoteApplication,
  sqliteFilePerTest,
} from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  echoSeen,
  KeyEchoApplication,
  KeyedEffectStart,
  resetEchoSeen,
} from "./fixtures/key-echo.application.js";

sqliteFilePerTest();
const sqlite = testWith(SqliteNoteApplication);
const echo = testWith(KeyEchoApplication);

beforeEach(() => {
  resetEchoSeen();
});

/** Tenant ids breaking each rule, with the rule. */
const REFUSED_TENANTS: readonly (readonly [string, KeyTextRule, string])[] = [
  ["a lone high surrogate", KeyTextRule.LoneSurrogate, "acme\uD800"],
  ["a lone low surrogate", KeyTextRule.LoneSurrogate, "acme\uDC01"],
  ["a C1 control", KeyTextRule.ControlCharacter, "acme\u0085"],
  ["a zero-width space", KeyTextRule.FormatCharacter, "acme​"],
  ["NFD", KeyTextRule.NotNfc, "café"],
  ["201 characters", KeyTextRule.Length, "t".repeat(201)],
];

/** What `call` rejected with. */
const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The error names the field and the rule, never the id. */
function expectRefusedTenant(error: unknown, rule: KeyTextRule, tenantId: string): void {
  expect(error).toBeInstanceOf(DtoValidationError);
  const { message } = error as Error;
  expect(message).toContain("tenantId");
  expect(message).toContain(`(${rule})`);
  expect(message).not.toContain(tenantId);
  expect(message).not.toContain("acme");
}

describe("#552 AC1: a tenant id breaking a rule is refused at execute, resume and cancel", () => {
  echo.for(REFUSED_TENANTS)("%s (%s)", async ([, rule, tenantId], { app }) => {
    const executed = await rejectionOf(
      execute(app, KeyedEffectStart, { text: "order:1" }, { tenant: { tenantId } }),
    );
    const resumed = await rejectionOf(
      app.resume({ pauseId: "p-1", decision: { approved: true } }, { tenantId, ownerId: "a" }),
    );
    const cancelled = await rejectionOf(app.cancel("thread-1", { tenantId }));

    for (const error of [executed, resumed, cancelled]) expectRefusedTenant(error, rule, tenantId);
    expect(echoSeen.ran).toBe(0);
  });
});

describe("#552 AC1: two tenant ids UTF-8 makes one never share a thread", () => {
  sqlite(
    "t\\uFFFD's thread, then t\\uD800 on the same thread id: refused before anything is read or written",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      const first = await execute(
        app,
        OrderWorkflowStart,
        { text: "a" },
        { threadId: "thread-x", ownerId: "alice", tenant: { tenantId: "t�" } },
      );

      const second = await rejectionOf(
        execute(
          app,
          OrderWorkflowStart,
          { text: "b" },
          { threadId: "thread-x", ownerId: "mallory", tenant: { tenantId: "t\uD800" } },
        ),
      );

      expect(first.tenantId).toBe("t�");
      expectRefusedTenant(second, KeyTextRule.LoneSurrogate, "t\uD800");
      await expect(
        app.cancel("thread-x", { tenantId: "t\uD801", ownerId: "alice" }),
      ).rejects.toBeInstanceOf(DtoValidationError);
    },
  );
});

describe("#552 AC2: app.cancel's thread id is a key's text", () => {
  echo.for([
    ["NFD", KeyTextRule.NotNfc, "café-thread"],
    ["a zero-width space", KeyTextRule.FormatCharacter, "thread​-1"],
    ["a lone surrogate", KeyTextRule.LoneSurrogate, "thread-\uD800"],
  ] as const)(
    "%s → InvalidThreadIdError, the id in no message and no event",
    async ([, rule, threadId], { app }) => {
      const error = await rejectionOf(app.cancel(threadId));

      expect(error).toBeInstanceOf(InvalidThreadIdError);
      expect(error).toMatchObject({ rule });
      expect((error as Error).message).not.toContain(threadId);
      expect(JSON.stringify(echoSeen.events)).not.toContain(JSON.stringify(threadId).slice(1, -1));
      expect(echoSeen.events).toEqual([
        expect.not.objectContaining({ threadId: expect.anything() }),
      ]);
    },
  );
});
