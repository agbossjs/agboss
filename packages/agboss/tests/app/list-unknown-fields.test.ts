/**
 * #1307e 21.3: a field a listing's query does not have (a retired `after`, a `role`, a typo) is a
 * `ValidationError.DtoInvalid`, never ignored — so a page loop cannot spin on page 1.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/error-families/effect-errors.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { AnyTenantApp } from "../../src/app/types.js";
import { HistoryDeskApplication } from "../flow/fixtures/execution-history.fixture.js";

const open = (): Promise<AnyTenantApp> =>
  createTestAppWith(HistoryDeskApplication, {
    processEnv: {},
    handleSignals: false,
    gateway: createScriptedGateway(new ScriptBook()),
  });

const rejection = async (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1307e 21.3: unknown query fields are refused by every listing", () => {
  it("listExecutions refuses after, role, offset and a typo, naming the field", async () => {
    const app = await open();
    try {
      for (const field of ["after", "role", "offset", "workflw"]) {
        const error = await rejection(app.listExecutions({ tenantId: "acme", [field]: "x" }));
        expect(error, field).toBeInstanceOf(ValidationError.DtoInvalid);
        expect(error).toMatchObject({ dto: "ExecutionsQuery" });
        expect(JSON.stringify((error as ValidationError.DtoInvalid).issues)).toContain(field);
      }
      expect((await app.listExecutions({ tenantId: "acme", limit: 5 })).items).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("pendingOutboundCallsOf refuses a field it does not have, as a rejection", async () => {
    const app = await open();
    try {
      const error = await rejection(
        app.pendingOutboundCallsOf({ tenantId: "acme", cursor: "1" } as never),
      );
      expect(error).toBeInstanceOf(ValidationError.DtoInvalid);
      expect(error).toMatchObject({ dto: "PendingOutboundCallsQuery" });
      expect((await app.pendingOutboundCallsOf({ tenantId: "acme", limit: 5 })).calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("#1307e L1: one strict instant for expiringBefore and startedAfter/startedBefore", async () => {
    const app = await open();
    try {
      for (const bad of ["5", "12", "Nov 26 2026", "2026-11-26T10:00", "2026-11-26", "", 5]) {
        for (const field of ["startedAfter", "startedBefore"]) {
          const error = await rejection(app.listExecutions({ tenantId: "acme", [field]: bad }));
          expect(error, `${field} ${String(bad)}`).toBeInstanceOf(ValidationError.DtoInvalid);
        }
        const pauses = await rejection(
          app.listPauses({ tenantId: "acme", expiringBefore: bad } as never),
        );
        expect(pauses, `expiringBefore ${String(bad)}`).toBeInstanceOf(ValidationError.DtoInvalid);
      }
      for (const good of [
        "2026-11-26T10:00:00Z",
        "2026-11-26T10:00:00.123+05:30",
        "2026-11-26T10:00Z",
      ]) {
        expect((await app.listExecutions({ tenantId: "acme", startedAfter: good })).items).toEqual(
          [],
        );
        expect((await app.listPauses({ tenantId: "acme", expiringBefore: good })).items).toEqual(
          [],
        );
      }
    } finally {
      await app.close();
    }
  });

  it("#1307e L2: a listExecutions cursor is bound to its tenant and filters", async () => {
    const app = await open();
    try {
      const forged = Buffer.from(JSON.stringify({ c: "1", h: "x" })).toString("base64url");
      for (const cursor of ["1", "not-a-cursor", forged]) {
        const error = await rejection(app.listExecutions({ tenantId: "acme", cursor }));
        expect(error, cursor).toBeInstanceOf(ValidationError.DtoInvalid);
        expect(error).toMatchObject({ dto: "ExecutionsQuery" });
      }
    } finally {
      await app.close();
    }
  });
});
