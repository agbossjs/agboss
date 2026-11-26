/**
 * #943 AC1: an operator lists a tenant's pauses (`app.listPauses`) by status, role and "expiring
 * before", page by page — every pause once across pages, a channel pause without its answering id,
 * another tenant's never, the ask masked by the pause's workflow's policies.
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import {
  PauseRespondent,
  PauseClosedReason,
  PauseKind,
  PauseStatus,
  type ListedPause,
  ValidationError,
} from "../../src/index.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ListManagerChannel,
  ListManagerExternalTask,
  ListingApplication,
  asked,
  financeFlow,
  managerFlow,
  openFlow,
  ownerFlow,
  resetAsked,
} from "../flow/fixtures/list-pauses.fixture.js";

const test = testWith(ListingApplication, { instances: 2 });
const manager = { actor: { id: "manager-17" } };

beforeEach(resetAsked);

const NOTE = "mail bob@example.com, ssn 123-45-6789";
const orderOf = (id: string) => ({ orderId: id, note: NOTE });

/** Opens a pause of `flow` for `tenantId`; returns its output. */
const open = (
  app: TestApp,
  flow: { readonly start: never },
  id: string,
  tenantId = "default",
  ownerId?: string,
) =>
  execute(app, flow.start, orderOf(id), {
    threadId: `t-${tenantId}-${id}`,
    tenant: { tenantId },
    ...(ownerId === undefined ? {} : { ownerId }),
  });

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

/** What every open listed pause has, and no closed one's fields. */
function expectOpenShape(one: ListedPause): void {
  expect(one.status).toBe(PauseStatus.Pending);
  for (const text of [one.rootExecutionId, one.threadId, one.askedAt]) expect(text).toBeTruthy();
  expect(one.reason).toBeUndefined();
  expect(one.closedAt).toBeUndefined();
}

/** Every page of a query, followed to its end. */
async function allOf(
  app: TestApp,
  query: Parameters<TestApp["listPauses"]>[0],
): Promise<ListedPause[]> {
  const found: ListedPause[] = [];
  let after: string | undefined;
  do {
    const page = await app.listPauses({
      ...query,
      ...(after === undefined ? {} : { cursor: after }),
    });
    found.push(...page.items);
    after = page.nextCursor;
  } while (after !== undefined);
  return found;
}

describe("#943 AC1: listing pauses", () => {
  test("AC1: filters each and combined — status (default pending), role, expiringBefore", async ({
    app,
    clock,
  }) => {
    await open(app, managerFlow as never, "m1");
    await open(app, financeFlow as never, "f1");
    await open(app, openFlow as never, "x1");
    const done = await open(app, managerFlow as never, "m2");
    expect(done.pending).toHaveLength(1);
    const pauseId = asked.sent.at(-1)?.pauseId ?? "";
    await app.resume({ pauseId, decision: { approved: true } }, manager);

    const roleOf = (pauses: readonly ListedPause[]) => pauses.map((one) => one.target).sort();
    // default: pending only — the answered one is not listed
    expect(roleOf(await allOf(app, { tenantId: "default" }))).toEqual(
      [managerFlow.role, financeFlow.role, openFlow.role].sort(),
    );
    const taken = await allOf(app, { tenantId: "default", status: PauseStatus.Taken });
    expect(taken.map((one) => one.status)).toEqual([PauseStatus.Taken]);
    const both = await allOf(app, {
      tenantId: "default",
      status: [PauseStatus.Pending, PauseStatus.Taken],
    });
    expect(both).toHaveLength(4);
    expect(await allOf(app, { tenantId: "default", target: financeFlow.role })).toHaveLength(1);
    // expiring within 3 hours: finance (2 h) only; the 24 h and the no-deadline ones are not
    const soon = new Date(clock.now().getTime() + hours(3));
    const expiring = await allOf(app, { tenantId: "default", expiringBefore: soon });
    expect(expiring.map((one) => one.target)).toEqual([financeFlow.role]);
    // combined
    expect(
      await allOf(app, { tenantId: "default", target: managerFlow.role, expiringBefore: soon }),
    ).toEqual([]);
    expect(
      await allOf(app, {
        tenantId: "default",
        target: managerFlow.role,
        status: [PauseStatus.Pending, PauseStatus.Taken],
        expiringBefore: new Date(clock.now().getTime() + hours(25)),
      }),
    ).toHaveLength(2);
  });

  test("AC1: 250 pauses, limit 100: three pages, each once", async ({ app }) => {
    for (let from = 0; from < 250; from += 25)
      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          open(app, openFlow as never, `o-${String(from + index)}`),
        ),
      );

    const first = await app.listPauses({ tenantId: "default" });
    expect(first.items).toHaveLength(100);
    const second = await app.listPauses({ tenantId: "default", cursor: first.nextCursor ?? "" });
    expect(second.items).toHaveLength(100);
    const third = await app.listPauses({ tenantId: "default", cursor: second.nextCursor ?? "" });
    expect(third.items).toHaveLength(50);
    expect(third.nextCursor).toBeUndefined();
    const keys = [...first.items, ...second.items, ...third.items].map((one) => one.pauseKey);
    expect(new Set(keys).size).toBe(250);
  });

  test("AC1: paging is stable under inserts and closes between pages (every pause with identical timestamps)", async ({
    app,
  }) => {
    for (let index = 0; index < 30; index += 1)
      await open(app, managerFlow as never, `s-${String(index)}`);
    const sent = [...asked.sent];
    const first = await app.listPauses({ tenantId: "default", limit: 10 });

    // between pages: a pause already listed is answered, one not yet listed is answered, a new one opens
    await app.resume({ pauseId: sent[0]?.pauseId ?? "", decision: { approved: true } }, manager);
    await app.resume({ pauseId: sent[15]?.pauseId ?? "", decision: { approved: true } }, manager);
    await open(app, managerFlow as never, "late");
    const rest: ListedPause[] = [];
    let after = first.nextCursor;
    while (after !== undefined) {
      const page = await app.listPauses({ tenantId: "default", limit: 10, cursor: after });
      rest.push(...page.items);
      after = page.nextCursor;
    }

    const keys = [...first.items, ...rest].map((one) => one.pauseKey);
    expect(new Set(keys).size).toBe(keys.length);
    // listed before it closed (the first), still pending (all but the one answered before its page),
    // and the new one appear — each once
    const answeredKey = pauseKeyOf("default", sent[15]?.pauseId ?? "");
    expect(keys).not.toContain(answeredKey);
    const stayed = sent.filter((_, index) => index !== 15);
    for (const one of stayed) expect(keys).toContain(pauseKeyOf("default", one.pauseId));
    expect(keys).toHaveLength(30);
  });

  test("AC1: no listed pause has a pauseId by default (Channel or ThreadOwner), pauseKey set; result.pending still gives the owner's", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "c1");
    const owned = await open(app, ownerFlow as never, "w1", "default", "alice");

    const pauses = await allOf(app, { tenantId: "default" });

    const channel = pauses.find((one) => one.target === managerFlow.role);
    const thread = pauses.find((one) => one.target === ownerFlow.role);
    const sentId = asked.sent[0]?.pauseId ?? "";
    expect(channel).toMatchObject({
      pauseKey: pauseKeyOf("default", sentId),
      respondent: PauseRespondent.Delegate,
    });
    expect(channel).not.toHaveProperty("pauseId");
    expect(channel).not.toHaveProperty("answeredBy");
    expect(thread).toMatchObject({
      respondent: PauseRespondent.Owner,
      kind: PauseKind.ExternalTask,
    });
    // H1: an Owner pause's id is a credential too (a thread without an ownerId is answered by it)
    expect(thread).not.toHaveProperty("pauseId");
    expect(owned.pending[0]?.pauseId).toBeTruthy();
    expect(JSON.stringify(pauses)).not.toContain(owned.pending[0]?.pauseId ?? "never");
    for (const one of pauses) expectOpenShape(one);
    expect(JSON.stringify(channel)).not.toContain(sentId);
  });

  test("AC1: another tenant's pauses are never listed, and the key text of a tenant is checked", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "a1", "tenant-a");
    await open(app, managerFlow as never, "b1", "tenant-b");

    const a = await allOf(app, { tenantId: "tenant-a" });
    const b = await allOf(app, { tenantId: "tenant-b" });

    expect(a.map((one) => one.threadId)).toEqual(["t-tenant-a-a1"]);
    expect(b.map((one) => one.threadId)).toEqual(["t-tenant-b-b1"]);
    expect(await allOf(app, { tenantId: "tenant-c" })).toEqual([]);
    // a cursor of one tenant's page does not read another's rows
    const page = await app.listPauses({ tenantId: "tenant-a", limit: 1 });
    expect(page.items).toHaveLength(1);
    const other = await app.listPauses({ tenantId: "tenant-b" });
    expect(other.items.map((one) => one.threadId)).toEqual(["t-tenant-b-b1"]);
    expect(await failureOf(app.listPauses({ tenantId: "t\uD800" }))).toBeInstanceOf(
      ValidationError.DtoInvalid,
    );
  });

  test("AC1: ask masked by the pause's own workflow's policies (the application's emails; the manager workflow's SSNs)", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "k1");
    await open(app, ownerFlow as never, "k2", "default", "alice");

    const pauses = await allOf(app, { tenantId: "default" });

    const text = (role: string): string =>
      JSON.stringify(pauses.find((one) => one.target === role)?.input);
    expect(text(managerFlow.role)).not.toContain("bob@example.com");
    expect(text(managerFlow.role)).not.toContain("123-45-6789");
    expect(text(managerFlow.role)).toContain("<email>");
    expect(text(managerFlow.role)).toContain("<us-ssn>");
    // the owner workflow lists no SSN policy: only the application's applies
    expect(text(ownerFlow.role)).not.toContain("bob@example.com");
    expect(text(ownerFlow.role)).toContain("123-45-6789");
  });

  test("AC1: closed ones come with reason and closedAt — answered, expired, cancelled", async ({
    app,
    clock,
  }) => {
    await open(app, managerFlow as never, "d1");
    const answeredId = asked.sent[0]?.pauseId ?? "";
    await open(app, financeFlow as never, "d2");
    await open(app, openFlow as never, "d3");
    await app.resume({ pauseId: answeredId, decision: { approved: true } }, manager);
    const answeredAt = clock.now().toISOString();
    await clock.advance(hours(3));
    await until(async () => (await allOf(app, { tenantId: "default" })).length === 1);
    await app.cancel("t-default-d3");

    const closed = await allOf(app, {
      tenantId: "default",
      status: [PauseStatus.Taken, PauseStatus.Resolved, PauseStatus.Cancelled],
    });

    const byReason = Object.fromEntries(closed.map((one) => [one.reason, one]));
    expect(Object.keys(byReason).sort()).toEqual(
      [PauseClosedReason.Answered, PauseClosedReason.Cancelled, PauseClosedReason.Expired].sort(),
    );
    expect(byReason[PauseClosedReason.Answered]?.actor).toEqual({ id: "manager-17" });
    expect(byReason[PauseClosedReason.Answered]?.closedAt).toBe(answeredAt);
    // an expiry closed at the deadline itself
    expect(byReason[PauseClosedReason.Expired]?.closedAt).toBe(
      byReason[PauseClosedReason.Expired]?.expiresAt,
    );
    expect(byReason[PauseClosedReason.Cancelled]?.actor).toBeUndefined();
    for (const one of closed) expect(one.closedAt).toBeTruthy();
  });

  test("a pause of a workflow the application does not list is masked with every workflow's policies", async ({
    app,
  }) => {
    await app.ready();
    const ghost = {
      ...pauseOf("ghost-pause", "ghost-root:q:1"),
      tenantId: "ghost-tenant",
      rootExecutionId: "ghost-root",
      executionId: "ghost-root",
      workflow: "removed-workflow",
      kind: PauseKind.ExternalTask,
      target: "removed-external-task",
      channel: "removed-channel",
      input: { note: "ssn 123-45-6789, mail bob@example.com" },
    };
    await app.resolve(PausedExecutionRepository).findOrCreateByStepKey(ghost);

    const [listed] = (await app.listPauses({ tenantId: "ghost-tenant" })).items;

    // the SSN is hidden by the manager workflow's policy alone, the email by the application's
    const text = JSON.stringify(listed?.input);
    expect(text).not.toContain("123-45-6789");
    expect(text).not.toContain("bob@example.com");
    expect(text).toContain("<us-ssn>");
  });

  test("a role no pause has, an empty page, limit 1 and 1000", async ({ app }) => {
    await open(app, openFlow as never, "e1");
    await open(app, openFlow as never, "e2");

    expect(await app.listPauses({ tenantId: "default", target: "no-such-external-task" })).toEqual({
      items: [],
    });
    const one = await app.listPauses({ tenantId: "default", limit: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.nextCursor).toBeDefined();
    const last = await app.listPauses({
      tenantId: "default",
      limit: 1,
      cursor: one.nextCursor ?? "",
    });
    expect(last.nextCursor).toBeUndefined();
    expect((await app.listPauses({ tenantId: "default", limit: 1000 })).items).toHaveLength(2);
  });

  test("an invalid query is a ValidationError.DtoInvalid of PausesQuery", async ({ app }) => {
    const bad: readonly unknown[] = [
      { tenantId: "default", limit: 0 },
      { tenantId: "default", limit: 1001 },
      { tenantId: "default", limit: 1.5 },
      { tenantId: "default", status: [] },
      { tenantId: "default", status: "gone" },
      { tenantId: "default", expiringBefore: new Date("nope") },
      { tenantId: "default", expiringBefore: "not a time" },
      { tenantId: "default", expiringBefore: "5" },
      { tenantId: "default", expiringBefore: "Nov 26 2026" },
      { tenantId: "default", expiringBefore: "2026-11-26T10:00" },
      { tenantId: "default", expiringBefore: "2026-11-26" },
      { tenantId: "default", expiringBefore: 12 },
      { tenantId: "default", assignee: "" },
      { tenantId: "default", externalRef: "" },
      { tenantId: "default", includePauseIds: "yes" },
      { tenantId: "default", allTenants: true },
      { allTenants: "all" },
      { tenantId: "default", target: 7 },
      { tenantId: "default", after: "0" },
      { tenantId: "default", target: "" },
      { tenantId: "default", cursor: "" },
      { tenantId: "default", cursor: "not-a-cursor" },
      { tenantId: 7 },
      "tenant-a",
    ];
    for (const query of bad) {
      const error = await failureOf(app.listPauses(query as never));
      expect(error, JSON.stringify(query)).toBeInstanceOf(ValidationError.DtoInvalid);
      expect((error as ValidationError.DtoInvalid).dto).toBe("PausesQuery");
    }
  });

  test('#1307e: no tenant named is the tenant "default"; allTenants lists every tenant\'s, paged by cursor', async ({
    app,
  }) => {
    await open(app, openFlow as never, "d1");
    await open(app, openFlow as never, "a1", "tenant-a");
    await open(app, openFlow as never, "b1", "tenant-b");

    const own = (await app.listPauses()).items.map((one) => one.threadId);
    const all = await allOf(app, { allTenants: true, limit: 2 } as never);

    expect(own).toEqual(["t-default-d1"]);
    expect(all.map((one) => one.threadId)).toEqual([
      "t-default-d1",
      "t-tenant-a-a1",
      "t-tenant-b-b1",
    ]);
    expect(all.map((one) => one.tenantId)).toEqual(["default", "tenant-a", "tenant-b"]);
    const first = await app.listPauses({ allTenants: true, limit: 2 } as never);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
  });

  test("#1307e: assignee, externalRef, target as a class and expiringBefore as a text filter the page", async ({
    app,
  }) => {
    await app.ready();
    const store = app.resolve(PausedExecutionRepository);
    const stored = (id: string, extra: object, tenantId = "default") =>
      store.findOrCreateByStepKey({
        ...pauseOf(id, `root-${id}:q:1`),
        tenantId,
        rootExecutionId: `root-${id}`,
        executionId: `root-${id}`,
        threadId: `thread-${id}`,
        ...extra,
      });
    const soon = "2026-01-05T10:00:00.000Z";
    await stored("p1", { assignees: ["ann", "bob"], externalRef: "JIRA-1", expiresAt: soon });
    await stored("p2", { assignees: ["bob"], externalRef: "JIRA-2" });
    await stored("p3", { assignees: ["ann"], externalRef: "JIRA-1" }, "tenant-b");
    await stored("p4", {});
    const threads = async (query: object): Promise<string[]> =>
      (await allOf(app, query as never)).map((one) => one.threadId);

    expect(await threads({ assignee: "bob" })).toEqual(["thread-p1", "thread-p2"]);
    expect(await threads({ assignee: "ann" })).toEqual(["thread-p1"]);
    expect(await threads({ assignee: "nobody" })).toEqual([]);
    expect(await threads({ externalRef: "JIRA-1" })).toEqual(["thread-p1"]);
    expect(await threads({ externalRef: "JIRA-1", allTenants: true })).toEqual([
      "thread-p1",
      "thread-p3",
    ]);
    expect(await threads({ assignee: "ann", externalRef: "JIRA-2" })).toEqual([]);
    expect(await threads({ assignee: "ann", allTenants: true })).toEqual([
      "thread-p1",
      "thread-p3",
    ]);
    expect(await threads({ target: "refund-tool-approval", assignee: "bob" })).toEqual([
      "thread-p1",
      "thread-p2",
    ]);
    expect(await threads({ expiringBefore: "2026-01-05T10:00:00.001Z" })).toEqual(["thread-p1"]);
    expect(await threads({ expiringBefore: soon })).toEqual([]);
    expect(await threads({ channel: "refund-approval-channel", assignee: "ann" })).toEqual([
      "thread-p1",
    ]);
    expect(await threads({ channel: "no-such-channel" })).toEqual([]);
    // a pause target class that is no target at all is a mistake, not an empty page
    expect(await failureOf(app.listPauses({ target: Object }))).toBeInstanceOf(Error);
  });

  test("#1307e AC3, H1: no pauseId (Owner or delegated) unless includePauseIds: true, then every item has one; never in an error", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "c1");
    const owned = await open(app, ownerFlow as never, "w1", "default", "alice");
    const sentId = asked.sent[0]?.pauseId ?? "";

    const byDefault = await allOf(app, {});
    const off = await allOf(app, { includePauseIds: false });
    const shown = await allOf(app, { includePauseIds: true });

    for (const page of [byDefault, off]) {
      expect(page).toHaveLength(2);
      for (const one of page) expect(one).not.toHaveProperty("pauseId");
      expect(JSON.stringify(page)).not.toContain(sentId);
      expect(JSON.stringify(page)).not.toContain(owned.pending[0]?.pauseId ?? "never");
    }
    expect(shown.find((one) => one.respondent === PauseRespondent.Delegate)?.pauseId).toBe(sentId);
    expect(shown.find((one) => one.respondent === PauseRespondent.Owner)?.pauseId).toBe(
      owned.pending[0]?.pauseId,
    );
    // errors raised while ids are in play: a cursor that is an id, a refused query with the flag on
    for (const query of [
      { includePauseIds: true, cursor: sentId },
      { includePauseIds: true, assignee: sentId, limit: 0 },
      { includePauseIds: true, target: sentId, status: sentId },
    ]) {
      const error = await failureOf(app.listPauses(query as never));
      expect(error, JSON.stringify(query)).toBeInstanceOf(ValidationError.DtoInvalid);
      const text = `${JSON.stringify(error)} ${(error as Error).message} ${String((error as Error).stack)}`;
      expect(text).not.toContain(sentId.slice(0, 12));
    }
    // allTenants with ids: every tenant's delegated id, each with its tenant
    await open(app, managerFlow as never, "c9", "tenant-z");
    const every = await allOf(app, { allTenants: true, includePauseIds: true } as never);
    expect(every.every((one) => typeof one.pauseId === "string")).toBe(true);
    expect(new Set(every.map((one) => one.tenantId))).toEqual(new Set(["default", "tenant-z"]));
    const hidden = await allOf(app, { allTenants: true } as never);
    expect(hidden.filter((one) => one.respondent === PauseRespondent.Delegate)).toSatisfy(
      (rest: ListedPause[]) => rest.length > 0 && rest.every((one) => one.pauseId === undefined),
    );
  });

  test("#1307e: a query field the listing does not have (a retired after, a role) is refused, never ignored", async ({
    app,
  }) => {
    for (const query of [{ after: "0" }, { role: "x" }, { next: "1" }]) {
      const error = await failureOf(app.listPauses(query as never));
      expect(error, JSON.stringify(query)).toBeInstanceOf(ValidationError.DtoInvalid);
    }
  });

  test("#1307e 21.2: channel filters by a @Channel class or its name; a class that is no channel is refused", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "m1");
    await open(app, financeFlow as never, "f1");
    const threads = async (query: object): Promise<string[]> =>
      (await allOf(app, query as never)).map((one) => one.threadId);

    expect(await threads({ channel: ListManagerChannel })).toEqual(["t-default-m1"]);
    // a target class is its name: same non-empty page
    const byClass = await threads({ target: ListManagerExternalTask });
    expect(byClass).toEqual(["t-default-m1"]);
    expect(await threads({ target: "list-manager-external-task" })).toEqual(byClass);
    expect(await threads({ target: managerFlow.role })).toEqual(byClass);
    expect(await threads({ channel: "list-manager-channel" })).toEqual(["t-default-m1"]);
    for (const bad of [ListManagerExternalTask, Object, "", 7]) {
      const error = await failureOf(app.listPauses({ channel: bad } as never));
      expect(error).toBeInstanceOf(ValidationError.DtoInvalid);
    }
  });

  test("#1307e M2: resuming an id under the wrong tenant tells the pause key, never the id", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "k1", "tenant-a");
    const [listed] = await allOf(app, { tenantId: "tenant-a", includePauseIds: true });
    const pauseId = listed?.pauseId ?? "";
    expect(pauseId).not.toBe("");
    expect(listed?.tenantId).toBe("tenant-a");

    const error = await failureOf(
      app.resume({ pauseId, decision: { approved: true } }, { tenantId: "tenant-b", ...manager }),
    );

    expect(error).toBeInstanceOf(PauseError.UnknownPause);
    expect(JSON.stringify(error)).not.toContain(pauseId);
    expect((error as Error).message).toContain(pauseKeyOf("tenant-b", pauseId));
  });

  test("#1307e L2: a cursor belongs to the query that made it: another tenant, filter or a forged one is refused", async ({
    app,
  }) => {
    await open(app, openFlow as never, "c1", "tenant-a");
    await open(app, openFlow as never, "c2", "tenant-a");
    await open(app, openFlow as never, "c3", "tenant-b");
    const page = await app.listPauses({ tenantId: "tenant-a", limit: 1 });
    const cursor = page.nextCursor ?? "";
    expect(cursor).not.toBe("");

    const same = await app.listPauses({ tenantId: "tenant-a", limit: 1, cursor });
    expect(same.items.map((one) => one.threadId)).toEqual(["t-tenant-a-c2"]);
    // the page size may change between pages
    expect((await app.listPauses({ tenantId: "tenant-a", limit: 5, cursor })).items).toHaveLength(
      1,
    );
    for (const other of [
      { tenantId: "tenant-b" },
      { allTenants: true },
      { tenantId: "tenant-a", assignee: "ann" },
      { tenantId: "tenant-a", status: PauseStatus.Taken },
      { tenantId: "tenant-a", expiringBefore: "2030-01-01T00:00:00Z" },
    ]) {
      const error = await failureOf(app.listPauses({ ...other, cursor }));
      expect(error, JSON.stringify(other)).toBeInstanceOf(ValidationError.DtoInvalid);
    }
    for (const forged of ["0", "1", "not-a-cursor", Buffer.from("{}").toString("base64url")]) {
      const error = await failureOf(app.listPauses({ tenantId: "tenant-a", cursor: forged }));
      expect(error, forged).toBeInstanceOf(ValidationError.DtoInvalid);
    }
  });

  test("#1307e: allTenants false with a tenantId lists that tenant; both given as true is refused", async ({
    app,
  }) => {
    await open(app, openFlow as never, "x1", "tenant-a");
    await open(app, openFlow as never, "x2", "tenant-b");

    const own = await allOf(app, { tenantId: "tenant-a", allTenants: false } as never);
    expect(own.map((one) => one.tenantId)).toEqual(["tenant-a"]);
    const error = await failureOf(
      app.listPauses({ tenantId: "tenant-a", allTenants: true } as never),
    );
    expect(error).toBeInstanceOf(ValidationError.DtoInvalid);
  });
});
