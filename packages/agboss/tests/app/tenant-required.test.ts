/**
 * #1324e: tenant safety of `App` at run time. An application that declares a `tenantContext`
 * serves many tenants: a call that needs one and names none is refused at its entry with
 * `ValidationError.TenantRequired` — before any store is read, never run as the tenant `"default"`,
 * never masked as a `NotFound`. An application without one has the one tenant `"default"`, which a
 * call may omit. `getExecution` and `listExecutions` read the kept root executions.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionHistoryRepository,
  ExecutionHistoryStatus,
  type ExecutionHistoryRecord,
} from "../../src/infrastructure/execution-history.repository.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { ValidationError } from "../../src/core/error-families/effect-errors.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { AnyTenantApp } from "../../src/app/types.js";
import { DeskWorkflowStart } from "../flow/fixtures/eval-desk.fixture.js";
import {
  HistoryDeskApplication,
  HistoryTreasuryApplication,
} from "../flow/fixtures/execution-history.fixture.js";
import { TreasuryWorkflowStart } from "../flow/fixtures/replies.fixture.js";

const open = (application: typeof HistoryDeskApplication): Promise<AnyTenantApp> =>
  createTestAppWith(application, {
    processEnv: {},
    handleSignals: false,
    gateway: createScriptedGateway(new ScriptBook()),
  });

/** A kept root execution, as much of it as a listing reads. */
const recordOf = (
  tenantId: string,
  executionId: string,
  startedAt: string,
  more: Partial<{ workflow: string; status: ExecutionHistoryStatus }> = {},
): ExecutionHistoryRecord =>
  ({
    executionId,
    rootExecutionId: executionId,
    threadId: `thread-${executionId}`,
    tenantId,
    workflow: { name: more.workflow ?? "desk", version: "1", startedVersion: "1" },
    status: more.status ?? ExecutionHistoryStatus.Finished,
    startedAt,
  }) as ExecutionHistoryRecord;

/** The error a call rejects with, when it does. */
const rejection = async (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1324e: an application with a tenantContext refuses a call that names no tenant", () => {
  const needing: readonly [string, (app: AnyTenantApp) => Promise<unknown>][] = [
    [
      "execute",
      (app) =>
        app.execute(
          DeskWorkflowStart,
          { text: "hi" },
          { tenant: { plan: "pro" }, execution: { userId: "u-1" } },
        ),
    ],
    ["resume", (app) => app.resume({ pauseId: "p", decision: {} })],
    ["cancel", (app) => app.cancel("thread-1")],
    ["extendPause", (app) => app.extendPause({ pauseId: "p", expiresIn: 1000 as never })],
    ["reassignPause", (app) => app.reassignPause({ pauseId: "p", assignee: "d" })],
    ["getExecution", (app) => app.getExecution("e-1")],
    ["getStatusHistory", (app) => app.getStatusHistory("thread-1")],
    ["listExecutions", (app) => app.listExecutions()],
    ["listExecutions", (app) => app.listExecutions({ limit: 5 })],
    ["listPauses", (app) => app.listPauses({} as never)],
    ["auditLogOf", (app) => app.auditLogOf({ rootExecutionId: "r" } as never)],
    ["outboundCallsOf", (app) => app.outboundCallsOf({ rootExecutionId: "r" } as never)],
    ["pendingOutboundCallsOf", (app) => app.pendingOutboundCallsOf({} as never)],
  ];

  it.each(needing)("%s rejects with ValidationError.TenantRequired", async (operation, call) => {
    const app = await open(HistoryDeskApplication);
    try {
      const error = await rejection(call(app));

      expect(error).toBeInstanceOf(ValidationError.TenantRequired);
      expect(error).toMatchObject({ code: "validation.tenant-required", operation });
    } finally {
      await app.close();
    }
  });

  it("refuses before any store is read, though the default tenant has data", async () => {
    const app = await open(HistoryDeskApplication);
    try {
      const history = app.resolve(ExecutionHistoryRepository);
      await history.save(recordOf("default", "e-default", "2026-01-01T00:00:00.000Z"));
      const reads = [
        vi.spyOn(history, "findByTenantIdAndExecutionId"),
        vi.spyOn(history, "findAllByTenantIdAndStartedAtBetween"),
        vi.spyOn(history, "findAllByStartedAtBetween"),
      ];

      await rejection(app.getExecution("e-default"));
      await rejection(app.listExecutions());
      await rejection(app.listExecutions({ tenantId: undefined, allTenants: undefined } as never));

      expect(reads.map((read) => read.mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      await app.close();
    }
  });

  it("a tenantId that is no text is refused too, never read as another tenant", async () => {
    const app = await open(HistoryDeskApplication);
    try {
      const error = await rejection(app.getExecution("e-1", { tenantId: 7 } as never));

      expect(error).toBeInstanceOf(ValidationError.TenantRequired);
    } finally {
      await app.close();
    }
  });

  it("a named tenant reads only its own records; another's are not found, never leaked", async () => {
    const app = await open(HistoryDeskApplication);
    try {
      const history = app.resolve(ExecutionHistoryRepository);
      await history.save(recordOf("acme", "e-acme", "2026-01-01T00:00:00.000Z"));
      await history.save(recordOf("globex", "e-globex", "2026-01-02T00:00:00.000Z"));
      await history.save(recordOf("default", "e-default", "2026-01-03T00:00:00.000Z"));

      const own = await app.getExecution("e-acme", { tenantId: "acme" });
      const other = await app.getExecution("e-acme", { tenantId: "globex" });
      const listed = await app.listExecutions({ tenantId: "acme" });
      const all = await app.listExecutions({ allTenants: true } as never);

      expect(own?.executionId).toBe("e-acme");
      expect(other).toBeUndefined();
      expect(listed.items.map((record) => record.executionId)).toEqual(["e-acme"]);
      expect(all.items.map((record) => record.executionId)).toEqual([
        "e-acme",
        "e-globex",
        "e-default",
      ]);
    } finally {
      await app.close();
    }
  });
});

describe("#1324e: an application without a tenantContext has the one tenant default", () => {
  it("a call may omit the tenant: it reads the default one", async () => {
    const app = await open(HistoryTreasuryApplication);
    try {
      const history = app.resolve(ExecutionHistoryRepository);
      await history.save(recordOf("default", "e-1", "2026-01-01T00:00:00.000Z"));
      await history.save(recordOf("other", "e-2", "2026-01-02T00:00:00.000Z"));

      expect((await app.getExecution("e-1"))?.executionId).toBe("e-1");
      expect(await app.getExecution("e-2")).toBeUndefined();
      expect((await app.listExecutions()).items.map((record) => record.executionId)).toEqual([
        "e-1",
      ]);
      expect(
        (await app.listExecutions({ tenantId: "other" })).items.map((r) => r.executionId),
      ).toEqual(["e-2"]);
    } finally {
      await app.close();
    }
  });

  it("an execute, cancel, resume and extend without a tenant are not refused for it", async () => {
    const app = await open(HistoryTreasuryApplication);
    try {
      const calls = [
        app.cancel("no-such-thread"),
        app.resume({ pauseId: "p", decision: {} }),
        app.extendPause({ pauseId: "p", expiresIn: 1000 as never }),
      ];

      for (const error of await Promise.all(calls.map(rejection))) {
        expect(error).toBeDefined();
        expect(error).not.toBeInstanceOf(ValidationError.TenantRequired);
      }
      expect(TreasuryWorkflowStart).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

describe("#1324e: listExecutions pages, filters and refuses a bad query", () => {
  const seeded = async (): Promise<AnyTenantApp> => {
    const app = await open(HistoryTreasuryApplication);
    const history = app.resolve(ExecutionHistoryRepository);
    const rows: [string, string, Partial<{ workflow: string; status: ExecutionHistoryStatus }>][] =
      [
        ["e-1", "2026-01-01T00:00:00.000Z", { workflow: "a" }],
        [
          "e-2",
          "2026-01-02T00:00:00.000Z",
          { workflow: "b", status: ExecutionHistoryStatus.Failed },
        ],
        ["e-3", "2026-01-03T00:00:00.000Z", { workflow: "a" }],
        ["e-4", "2026-01-04T00:00:00.000Z", { workflow: "b" }],
      ];
    for (const [id, at, more] of rows) await history.save(recordOf("default", id, at, more));
    return app;
  };
  const ids = (page: { readonly items: readonly ExecutionHistoryRecord[] }): string[] =>
    page.items.map((record) => record.executionId);

  it("walks pages by cursor, oldest start first, to the last", async () => {
    const app = await seeded();
    try {
      const first = await app.listExecutions({ limit: 3 });
      const last = await app.listExecutions({ limit: 3, cursor: first.nextCursor ?? "" });

      expect(ids(first)).toEqual(["e-1", "e-2", "e-3"]);
      expect(first.nextCursor).toBeDefined();
      expect(ids(last)).toEqual(["e-4"]);
      expect(last.nextCursor).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("keeps the window half-open, as a Date or an ISO text", async () => {
    const app = await seeded();
    try {
      const page = await app.listExecutions({
        startedAfter: new Date("2026-01-02T00:00:00.000Z"),
        startedBefore: "2026-01-04T00:00:00.000Z",
      });

      expect(ids(page)).toEqual(["e-2", "e-3"]);
    } finally {
      await app.close();
    }
  });

  it("filters by workflow and by status", async () => {
    const app = await seeded();
    try {
      expect(ids(await app.listExecutions({ workflow: "b" }))).toEqual(["e-2", "e-4"]);
      expect(ids(await app.listExecutions({ status: ExecutionHistoryStatus.Failed }))).toEqual([
        "e-2",
      ]);
      expect(
        ids(
          await app.listExecutions({
            workflow: "b",
            status: [ExecutionHistoryStatus.Failed, ExecutionHistoryStatus.Finished],
          }),
        ),
      ).toEqual(["e-2", "e-4"]);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["a limit of 0", { limit: 0 }, "limit"],
    ["a fractional limit", { limit: 1.5 }, "limit"],
    ["a limit past the largest", { limit: 1001 }, "limit"],
    ["an invalid date", { startedAfter: "not a date" }, "startedAfter"],
    ["a cursor no listing gave", { cursor: "zzz" }, "cursor"],
  ])("%s is dto.invalid naming the field", async (_name, query, path) => {
    const app = await seeded();
    try {
      const error = await rejection(app.listExecutions(query));

      expect(error).toBeInstanceOf(DtoValidationError);
      expect(error).toMatchObject({ dto: "ExecutionsQuery", issues: [{ path }] });
    } finally {
      await app.close();
    }
  });
});
