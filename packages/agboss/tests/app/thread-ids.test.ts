/**
 * #262 Q4: `app.execute(Start, input, { threadId })` with an id the tenant does not have yet
 * creates that thread — the caller's own, idempotent id — keyed by tenant + thread and bound to
 * `ownerId`. An existing thread keeps its rules (another owner → `ThreadOwnerError`); `resume` and
 * `cancel` of an unknown thread stay `UnknownThreadError`; a refused execution creates nothing.
 */
import { describe, expect } from "vitest";
import {
  BudgetExceededError,
  InvalidThreadIdError,
  ThreadOwnerError,
  UnknownThreadError,
} from "../../src/errors.js";
import { replyWith, routeTo, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChatStart,
  DeskApplication,
  DeskTenantDailyBudget,
  MainRouter,
  Writer,
} from "../testing/fixtures/desk.workflow.js";

const test = testWith(DeskApplication);

/** What the writer was told about the thread's earlier turns: its history message, if any. */
const historyOf = (request: unknown): string =>
  JSON.stringify(request).includes("order-7 first") ? "with the first turn" : "without it";

describe("#262 Q4: a caller's own thread id", () => {
  test("a new id is created, and continued by the next execution", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer), routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("one"), replyWith("two"));

    const first = await execute(app, ChatStart, { text: "order-7 first" }, { threadId: "order-7" });
    const second = await execute(app, ChatStart, { text: "again" }, { threadId: "order-7" });

    expect([first.threadId, second.threadId]).toEqual(["order-7", "order-7"]);
    expect(historyOf(mockLlm(Writer).lastRequest)).toBe("with the first turn");
    expect(await app.cancel("order-7")).toEqual({ cancelled: false });
  });

  test("the same id from another tenant is a different thread", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer), routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("acme"), replyWith("globex"));
    const shared = "order-7";

    await execute(
      app,
      ChatStart,
      { text: "order-7 first" },
      { threadId: shared, tenant: { tenantId: "acme" } },
    );
    const other = await execute(
      app,
      ChatStart,
      { text: "hello" },
      { threadId: shared, tenant: { tenantId: "globex" } },
    );

    expect(other.threadId).toBe(shared);
    expect(other.tenantId).toBe("globex");
    expect(historyOf(mockLlm(Writer).lastRequest)).toBe("without it");
    await expect(app.cancel(shared)).rejects.toBeInstanceOf(UnknownThreadError);
  });

  test("the same id from another owner of the tenant is ThreadOwnerError", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("for alice"));
    await execute(app, ChatStart, { text: "hi" }, { threadId: "order-7", ownerId: "alice" });

    const mallory = execute(
      app,
      ChatStart,
      { text: "hi" },
      { threadId: "order-7", ownerId: "mallory" },
    );

    await expect(mallory).rejects.toBeInstanceOf(ThreadOwnerError);
    await expect(mallory).rejects.not.toThrow(/alice|mallory/);
  });

  test("an id that cannot be a thread is rejected; nothing is created", async ({ app }) => {
    for (const threadId of ["", "a\u0000b", "x".repeat(201)]) {
      await expect(execute(app, ChatStart, { text: "hi" }, { threadId })).rejects.toBeInstanceOf(
        InvalidThreadIdError,
      );
    }
    // #552: cancel holds its thread id to the same rules — refused for its text, before any lookup
    await expect(app.cancel("a\u0000b")).rejects.toBeInstanceOf(InvalidThreadIdError);
  });

  test("a refused execution creates nothing: no thread before the budget check", async ({
    app,
    mockOf,
  }) => {
    mockOf(DeskTenantDailyBudget).maxSpend.mockReturnValue(usd(0));

    const refused = execute(app, ChatStart, { text: "hi" }, { threadId: "order-8" });

    await expect(refused).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(app.cancel("order-8")).rejects.toBeInstanceOf(UnknownThreadError);
  });
});
