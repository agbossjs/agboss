/**
 * #943 AC1: an operator lists a tenant's pauses (`app.listPauses`) by status, role and "expiring
 * before", page by page — every pause once across pages, a channel pause without its answering id,
 * another tenant's never, the ask masked by the pause's workflow's policies.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/errors.js";
import {
  PauseAnswerer,
  PauseClosedReason,
  PauseKind,
  PauseStatus,
  pauseKeyOf,
  type ListedPause,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
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
    const page = await app.listPauses({ ...query, ...(after === undefined ? {} : { after }) });
    found.push(...page.pauses);
    after = page.next;
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

    const roleOf = (pauses: readonly ListedPause[]) => pauses.map((one) => one.channel).sort();
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
    expect(await allOf(app, { tenantId: "default", role: financeFlow.role })).toHaveLength(1);
    // expiring within 3 hours: finance (2 h) only; the 24 h and the no-deadline ones are not
    const soon = new Date(clock.now().getTime() + hours(3));
    const expiring = await allOf(app, { tenantId: "default", expiringBefore: soon });
    expect(expiring.map((one) => one.channel)).toEqual([financeFlow.role]);
    // combined
    expect(
      await allOf(app, { tenantId: "default", role: managerFlow.role, expiringBefore: soon }),
    ).toEqual([]);
    expect(
      await allOf(app, {
        tenantId: "default",
        role: managerFlow.role,
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
    expect(first.pauses).toHaveLength(100);
    const second = await app.listPauses({ tenantId: "default", after: first.next ?? "" });
    expect(second.pauses).toHaveLength(100);
    const third = await app.listPauses({ tenantId: "default", after: second.next ?? "" });
    expect(third.pauses).toHaveLength(50);
    expect(third.next).toBeUndefined();
    const keys = [...first.pauses, ...second.pauses, ...third.pauses].map((one) => one.pauseKey);
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
    let after = first.next;
    while (after !== undefined) {
      const page = await app.listPauses({ tenantId: "default", limit: 10, after });
      rest.push(...page.pauses);
      after = page.next;
    }

    const keys = [...first.pauses, ...rest].map((one) => one.pauseKey);
    expect(new Set(keys).size).toBe(keys.length);
    // listed before it closed (the first), still pending (all but the one answered before its page),
    // and the new one appear — each once
    const answeredKey = pauseKeyOf("default", sent[15]?.pauseId ?? "");
    expect(keys).not.toContain(answeredKey);
    const stayed = sent.filter((_, index) => index !== 15);
    for (const one of stayed) expect(keys).toContain(pauseKeyOf("default", one.pauseId));
    expect(keys).toHaveLength(30);
  });

  test("AC1: a Channel pause: no pauseId, pauseKey set; a ThreadOwner one: pauseId", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "c1");
    const owned = await open(app, ownerFlow as never, "w1", "default", "alice");

    const pauses = await allOf(app, { tenantId: "default" });

    const channel = pauses.find((one) => one.channel === managerFlow.role);
    const thread = pauses.find((one) => one.channel === ownerFlow.role);
    const sentId = asked.sent[0]?.pauseId ?? "";
    expect(channel).toMatchObject({
      pauseKey: pauseKeyOf("default", sentId),
      answerer: PauseAnswerer.Channel,
    });
    expect(channel).not.toHaveProperty("pauseId");
    expect(channel).not.toHaveProperty("answeredBy");
    expect(thread).toMatchObject({
      pauseId: owned.pending[0]?.pauseId,
      answerer: PauseAnswerer.ThreadOwner,
      kind: PauseKind.Question,
    });
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
    expect(page.pauses).toHaveLength(1);
    const other = await app.listPauses({ tenantId: "tenant-b", after: "0" });
    expect(other.pauses.map((one) => one.threadId)).toEqual(["t-tenant-b-b1"]);
    expect(await failureOf(app.listPauses({ tenantId: "t\uD800" }))).toBeInstanceOf(
      DtoValidationError,
    );
  });

  test("AC1: ask masked by the pause's own workflow's policies (the application's emails; the manager workflow's SSNs)", async ({
    app,
  }) => {
    await open(app, managerFlow as never, "k1");
    await open(app, ownerFlow as never, "k2", "default", "alice");

    const pauses = await allOf(app, { tenantId: "default" });

    const text = (role: string): string =>
      JSON.stringify(pauses.find((one) => one.channel === role)?.input);
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
      kind: PauseKind.Question,
      channel: "removed-question",
      input: { note: "ssn 123-45-6789, mail bob@example.com" },
    };
    await app.resolve(PausedExecutionRepository).findOrCreateByStepKey(ghost);

    const [listed] = (await app.listPauses({ tenantId: "ghost-tenant" })).pauses;

    // the SSN is hidden by the manager workflow's policy alone, the email by the application's
    const text = JSON.stringify(listed?.input);
    expect(text).not.toContain("123-45-6789");
    expect(text).not.toContain("bob@example.com");
    expect(text).toContain("<us-ssn>");
  });

  test("a role no pause has, an empty page, limit 1 and 1000", async ({ app }) => {
    await open(app, openFlow as never, "e1");
    await open(app, openFlow as never, "e2");

    expect(await app.listPauses({ tenantId: "default", role: "no-such-question" })).toEqual({
      pauses: [],
    });
    const one = await app.listPauses({ tenantId: "default", limit: 1 });
    expect(one.pauses).toHaveLength(1);
    expect(one.next).toBeDefined();
    const last = await app.listPauses({ tenantId: "default", limit: 1, after: one.next ?? "" });
    expect(last.next).toBeUndefined();
    expect((await app.listPauses({ tenantId: "default", limit: 1000 })).pauses).toHaveLength(2);
  });

  test("an invalid query is a DtoValidationError of PausesQuery", async ({ app }) => {
    const bad: readonly unknown[] = [
      { tenantId: "default", limit: 0 },
      { tenantId: "default", limit: 1001 },
      { tenantId: "default", limit: 1.5 },
      { tenantId: "default", status: [] },
      { tenantId: "default", status: "gone" },
      { tenantId: "default", expiringBefore: new Date("nope") },
      { tenantId: "default", expiringBefore: "2026-01-01" },
      { tenantId: "default", role: "" },
      { tenantId: "default", after: "" },
      { tenantId: "default", after: "not-a-cursor" },
      { tenantId: 7 },
      {},
      null,
    ];
    for (const query of bad) {
      const error = await failureOf(app.listPauses(query as never));
      expect(error, JSON.stringify(query)).toBeInstanceOf(DtoValidationError);
      expect((error as DtoValidationError).dto).toBe("PausesQuery");
    }
  });
});
