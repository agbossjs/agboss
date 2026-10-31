/**
 * #580 — a root execution id is a key's text at the operator's reads of a tree, as its tenant id is
 * (#552): `app.leaseEventsOf` and `app.outboundCallsOf`. On SQLite (and PostgreSQL) `r\uD800` is
 * stored and compared as `r�`, so the store would hand a read under a lone surrogate root
 * `r�`'s rows; every other refused text names no tree. Each read refuses it with `dto.invalid`
 * naming `rootExecutionId` and the rule, never the id, before the store is asked — and checks the
 * tenant id first.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/errors.js";
import {
  ExecutionLeaseEventKind,
  ExecutionLeaseEventRepository,
  LeaseTakeoverReason,
  type LeaseTakeoverRecord,
} from "../../src/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { testWith } from "../../src/testing/index.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { SqliteOutboundCallApplication } from "../infrastructure/sqlite/fixtures/sqlite-outbound-call.application.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { resetRuns } from "./fixtures/outbound-call.workflow.js";
import { resetGateway } from "./fixtures/payment-gateway.js";
import { REFUSED_KEYS } from "./fixtures/key-texts.js";

sqliteFilePerTest();
const sqlite = testWith(SqliteOutboundCallApplication);

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

/** The root whose rows a lone surrogate would read on a UTF-8 database. */
const REPLACED = "r�";

/** A takeover row of `rootExecutionId`, kept in the lease log. */
const takeoverOf = (rootExecutionId: string): LeaseTakeoverRecord => ({
  kind: ExecutionLeaseEventKind.Takeover,
  occurredAt: "2026-01-05T09:00:00.000Z",
  tenantId: "default",
  rootExecutionId,
  executionId: rootExecutionId,
  scopeKey: `default:${encodeURIComponent(rootExecutionId)}`,
  token: 2,
  holderInstanceId: "instance-2",
  reason: LeaseTakeoverReason.Recovered,
  previousHolderInstanceId: "instance-1",
  previousToken: 1,
});

/** Every read of an operator that takes a tree. */
const reads = (app: TestApp, tenantId: string, rootExecutionId: string) =>
  [
    ["leaseEventsOf", () => app.leaseEventsOf({ tenantId, rootExecutionId })],
    ["outboundCallsOf", () => app.outboundCallsOf({ tenantId, rootExecutionId })],
  ] as const;

const rejectionOf = (call: () => Promise<unknown>): Promise<unknown> =>
  call().then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#580: a root execution id at the operator's reads of a tree", () => {
  sqlite(
    "a lone surrogate never reads root r\\uFFFD's lease log — which the store alone would hand it: refused, the id not named",
    async ({ app }) => {
      await app.ready();
      const leaseLog = app.resolve(ExecutionLeaseEventRepository);
      await leaseLog.save(takeoverOf(REPLACED));
      expect(await app.leaseEventsOf({ tenantId: "default", rootExecutionId: REPLACED })).toEqual([
        expect.objectContaining({ rootExecutionId: REPLACED }),
      ]);
      // the store merges them: what the check keeps the read from
      expect(
        await leaseLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt("default", "r\uD800"),
      ).toHaveLength(1);

      for (const surrogate of ["r\uD800", "r\uDFFF"])
        for (const [read, made] of reads(app, "default", surrogate)) {
          const error = await rejectionOf(made);
          expect(error, read).toBeInstanceOf(DtoValidationError);
          const { message } = error as Error;
          expect(message, read).toContain("rootExecutionId");
          expect(message, read).toContain("(lone-surrogate)");
          expect(message, read).not.toContain(surrogate);
        }
    },
  );

  sqlite.for(REFUSED_KEYS)(
    "%s (%s): refused at every read of a tree, naming rootExecutionId and the rule, never the id",
    async ([, rule, rootExecutionId], { app }) => {
      await app.ready();
      for (const [read, made] of reads(app, "default", rootExecutionId)) {
        const error = await rejectionOf(made);
        expect(error, read).toBeInstanceOf(DtoValidationError);
        const { message } = error as Error;
        expect(message, read).toContain("rootExecutionId");
        expect(message, read).toContain(`(${rule})`);
        if (rootExecutionId.length > 0) expect(message, read).not.toContain(rootExecutionId);
      }
    },
  );

  sqlite("the tenant id is checked first: both refused, the tenant named", async ({ app }) => {
    await app.ready();
    for (const [read, made] of reads(app, "t\uD800", "r\uD800")) {
      const { message } = (await rejectionOf(made)) as Error;
      expect(message, read).toContain("tenantId");
      expect(message, read).not.toContain("rootExecutionId");
    }
  });

  sqlite("an accepted root execution id reads as before", async ({ app }) => {
    await app.ready();
    for (const [read, made] of reads(app, "acme", "execution-1"))
      expect(await made(), read).toEqual([]);
  });
});
