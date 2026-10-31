/**
 * #552 acceptance — a tenant id is a key's text at every API that takes one, the operator's reads
 * too: `app.leaseEventsOf`, `app.outboundCallsOf` and `app.pendingOutboundCalls`. On SQLite (and
 * PostgreSQL) `t\uD800` is stored as `t�`, so a read under a lone surrogate would be another
 * tenant's rows; any other refused text names no tenant that could exist. Each read refuses it with
 * `dto.invalid` naming `tenantId` and the rule, never the id, before the store is asked.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/errors.js";
import { OutboundCallStatus } from "../../src/index.js";
import type { App } from "../../src/app/types.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { SqliteOutboundCallApplication } from "../infrastructure/sqlite/fixtures/sqlite-outbound-call.application.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { ChargeWorkflowStart, resetRuns } from "./fixtures/outbound-call.workflow.js";
import { frozenCharges, gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";
import { REFUSED_KEYS } from "./fixtures/key-texts.js";

sqliteFilePerTest();
const sqlite = testWith(SqliteOutboundCallApplication);

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

afterEach(letChargesGo);

/** The tenant whose rows a lone surrogate would read on a UTF-8 database. */
const REPLACED = "t�";

/** Every read of an operator that takes a tenant id. */
const reads = (app: App, tenantId: string) =>
  [
    ["leaseEventsOf", () => app.leaseEventsOf({ tenantId, rootExecutionId: "execution-1" })],
    ["outboundCallsOf", () => app.outboundCallsOf({ tenantId, rootExecutionId: "execution-1" })],
    ["pendingOutboundCalls", () => app.pendingOutboundCalls({ tenantId })],
  ] as const;

const rejectionOf = (call: () => Promise<unknown>): Promise<unknown> =>
  call().then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#552 acceptance: a tenant id at the operator's reads", () => {
  sqlite(
    "a lone surrogate never reads t\\uFFFD's lease log, calls or pending calls: refused, the id not named",
    async ({ app }) => {
      gateway.gates.after = 1;
      const call = execute(
        app,
        ChargeWorkflowStart,
        { text: "order-7 alice@example.com" },
        { tenant: { tenantId: REPLACED } },
      );
      call.catch(() => undefined);
      await frozenCharges(1);
      expect(await app.pendingOutboundCalls({ tenantId: REPLACED })).toEqual([
        expect.objectContaining({ status: OutboundCallStatus.Pending }),
      ]);

      for (const surrogate of ["t\uD800", "t\uDFFF"])
        for (const [read, made] of reads(app, surrogate)) {
          const error = await rejectionOf(made);
          expect(error, read).toBeInstanceOf(DtoValidationError);
          expect((error as Error).message, read).toContain("tenantId");
          expect((error as Error).message, read).toContain("(lone-surrogate)");
          expect((error as Error).message, read).not.toContain(surrogate);
        }
    },
  );

  sqlite.for(REFUSED_KEYS)(
    "%s (%s): refused at every read, naming tenantId and the rule, never the id",
    async ([, rule, tenantId], { app }) => {
      await app.ready();
      for (const [read, made] of reads(app, tenantId)) {
        const error = await rejectionOf(made);
        expect(error, read).toBeInstanceOf(DtoValidationError);
        const { message } = error as Error;
        expect(message, read).toContain("tenantId");
        expect(message, read).toContain(`(${rule})`);
        if (tenantId.length > 0) expect(message, read).not.toContain(tenantId);
      }
    },
  );

  sqlite("an accepted tenant id reads as before", async ({ app }) => {
    await app.ready();
    for (const [read, made] of reads(app, "acme")) expect(await made(), read).toEqual([]);
  });
});
