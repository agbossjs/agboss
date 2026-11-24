/**
 * #508 — the concurrency review of the outbound-call protocol, one scenario per finding: a lease
 * stays open while an attempt under it is in flight; a lost completion is `OutboundCallError.Superseded`, never a
 * silent `Sent`; a live owner is never reconciled, whatever the key; a joined call never takes on
 * the first call's own hand-over or cancel; an answered call always ends `Completed`; what a
 * business key derives is keyed; the key sent out is unambiguous.
 */
import {
  IdempotencyError,
  OutboundCallError,
} from "../../src/core/error-families/effect-errors.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  ExecutionLeaseRepository,
  Injectable,
  InMemoryOutboundCallRepository,
  OutboundCallSendStatus,
  OutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallRecord,
} from "../../src/index.js";
import { effectKeyOf, type EffectKey } from "../../src/stores/index.js";
import { stateOf } from "../../src/app/outbound-call-business.js";
import { maskedTextOf } from "../../src/app/outbound-call-parts.js";
import { REDACTED } from "../../src/app/outbound-call-errors.js";
import { Clock, StoreClock } from "../../src/infrastructure/clock.js";
import { FINGERPRINT_LABEL } from "../../src/infrastructure/fenced-effect-key.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { TEST_PSEUDONYM_KEY } from "../../src/pii/application-key.js";
import { keyedDigestOf } from "../../src/pii/tokens.js";
import { stableJson } from "../../src/turns/index.js";
import { testUnit, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { recordingLog } from "../helpers/log.js";
import { instance, settle } from "./fixtures/fence-takeover.js";
import {
  BusinessKeyApplication,
  ledger,
  letLedgerGo,
  resetLedger,
  SendChargeStart,
} from "./fixtures/business-key.workflow.js";
import { ChargeOrderAction, resetRuns, runs } from "./fixtures/outbound-call.workflow.js";
import { frozenCharges, gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";
import { untilReached } from "../helpers/reached.js";
import { TEST_IDEMPOTENCY_KEY } from "../../src/application/idempotency-key.js";

const test = testWith(BusinessKeyApplication);
const two = testWith(BusinessKeyApplication, { instances: 2 });
const order = { message: { value: { text: "order-1" } } } as never;
const charge = { orderId: "42", amountUsd: 10 };

/** Until `count` outbound charges of the business-key fixture are frozen. */
async function frozenLedger(count: number): Promise<void> {
  await untilReached(() => ledger.frozen.length >= count, `${String(count)} charges never froze`);
}

beforeEach(() => {
  resetLedger();
  resetGateway();
  resetRuns();
});

afterEach(() => {
  letLedgerGo();
  letChargesGo();
});

describe("#508 review 1a: a lease stays open while an attempt under it is in flight", () => {
  two(
    "a cancelled execution whose send ignores its signal: the other instance sees the call in flight until the send settles, then replays it",
    async ({ apps }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await Promise.all([a.ready(), b.ready()]);
      Object.assign(ledger, { freeze: 1, ignoresAbort: true });
      const first = execute(a, SendChargeStart, charge, { threadId: "thread-first" });
      first.catch(() => undefined);
      await frozenLedger(1);
      void a.cancel("thread-first", { tenantId: "default" }).catch(() => undefined);
      await settle();

      await expect(execute(b, SendChargeStart, charge)).rejects.toFailWith(
        OutboundCallError.InFlight,
        { call: "charge" },
      );
      letLedgerGo();
      await first.catch(() => undefined);
      await settle();
      const later = await execute(b, SendChargeStart, charge);

      expect(gateway.calls).toHaveLength(1);
      expect(ledger.outbound.at(-1)).toBe(OutboundCallSendStatus.Replayed);
      expect(later.output).toEqual({ chargeId: "ch-42-1" });
    },
  );
});

/** The rival that takes the attempt over between this call's send and its completion. */
@Injectable({ deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
class SupersedingOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async markCompleted(key: EffectKey, owner: string, result: string) {
    const found = await this.findByKey(key);
    if (found !== undefined) await this.#takenOver(key, found);
    return super.markCompleted(key, owner, result, null);
  }

  async #takenOver(key: EffectKey, found: OutboundCallRecord): Promise<void> {
    await this.markPending(key, stateOf(found), { attempt: found.attempt + 1, attemptOwner: "x" });
  }
}

describe("#508 review 2, #795: a lost completion is OutboundCallError.Superseded, never a silent Sent", () => {
  it("a newer attempt took the intent over while this one was in flight: the step fails naming both attempts, the newer attempt's intent kept", async () => {
    const run = testUnit(ChargeOrderAction, {
      services: [SupersedingOutboundCallRepository],
    });

    const failed = await run(order).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(OutboundCallError.Superseded);
    expect(failed).toMatchObject({
      code: "outbound-call.superseded",
      call: "charge",
      target: "payments",
      operation: "charge",
      attempt: 1,
      supersededBy: 2,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) as unknown,
    });
    expect(runs.outcomes).toEqual([]);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("#508 review 3: a live owner is never reconciled, whatever the key", () => {
  it("a step-keyed attempt still sending (its step aborted, its client ignoring it): the step run again is in flight, nothing sent", async () => {
    const run = testUnit(ChargeOrderAction);
    Object.assign(gateway.gates, { before: 1, ignoresAbort: true });
    const first = run(order, { timeout: seconds(1) });
    first.catch(() => undefined);
    await frozenCharges(1);
    await run.clock.advance(seconds(1));
    await expect(first).rejects.toThrow();

    await expect(run(order)).rejects.toBeInstanceOf(OutboundCallError.InFlight);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.lookups).toEqual([]);
  });
});

describe("#508 review 4: a joined call never takes on the first call's own error", () => {
  test("the first execution is cancelled while the second waits on it: the second is not cancelled — it makes its own call, which finds the first's lease still open", async ({
    app,
  }) => {
    ledger.freeze = 1;
    const first = execute(app, SendChargeStart, charge, { threadId: "thread-first" });
    first.catch(() => undefined);
    await frozenLedger(1);
    const second = execute(app, SendChargeStart, charge);
    await settle(); // the second joins the first
    await app.cancel("thread-first", { tenantId: "default" });

    await expect(second).rejects.toFailWith(OutboundCallError.InFlight, { call: "charge" });
    await settle();
    const third = await execute(app, SendChargeStart, charge);

    expect(third.output).toEqual({ chargeId: "ch-42-1" });
    expect(gateway.lookups).toHaveLength(1);
    expect(gateway.calls).toEqual([
      { idempotencyKey: "kozeA6UXkFQOmJlRz1_iDumLcer6Ops_OXo1PjSvjAw", attempt: 2 },
    ]);
  });
});

describe("#508 review 5: an answered call always ends Completed", () => {
  it("a failure's text the mask cannot mask is stored [redacted], never as it is", async () => {
    const run = {
      frame: { execution: { observability: { traceData: () => Promise.reject(new Error("x")) } } },
      parts: { settings: { requiresMask: false }, log: recordingLog().log },
      key: { name: "charge", tenantId: "default" },
      options: { target: "payments", operation: "charge" },
    } as never;

    expect(await maskedTextOf(run, "card of ann@example.com declined")).toBe(REDACTED);
  });
});

describe("#508 review 6: what a business key derives is keyed", () => {
  test("a fingerprint is an HMAC under the application's key — never a plain SHA-256 of the request", async ({
    app,
  }) => {
    const result = await execute(app, SendChargeStart, charge);
    // the store's row: no read surface shows a fingerprint (#508 re-review MEDIUM4)
    const [call] = await app
      .resolve(OutboundCallRepository)
      .findAllByTenantIdAndRootExecutionId("default", result.executionId);
    const text = `fingerprint\u0000${stableJson(charge)}`;
    const subkey = keyedDigestOf(TEST_IDEMPOTENCY_KEY, FINGERPRINT_LABEL);
    const underPiiKey = keyedDigestOf(keyedDigestOf(TEST_PSEUDONYM_KEY, FINGERPRINT_LABEL), text);

    expect(call?.fingerprint).toBe(keyedDigestOf(subkey, text));
    // #825: the idempotency key's, never the PII key's
    expect(call?.fingerprint).not.toBe(underPiiKey);
    expect(call?.fingerprint).not.toBe(
      createHash("sha256").update(stableJson(charge)).digest("hex"),
    );
    expect(call?.status).toBe(OutboundCallStatus.Completed);
  });

  it("an unreconciled call's detail is masked by the frame's mask", async () => {
    const masked = (text: string) => Promise.resolve(text.replace(/\S+@\S+/u, "<email>"));
    const run = {
      frame: { execution: { observability: { traceData: masked } } },
      parts: { settings: { requiresMask: true } },
    } as never;

    expect(await maskedTextOf(run, "held for ann@example.com")).toBe("held for <email>");
  });
});

@Action({
  name: "badly-named-action",
  description: "Keys an effect by a name with a colon",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext],
})
class BadlyNamedAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<void> {
    effectKeyOf(this.executionContext, "charge:twice");
    return Promise.resolve();
  }
}

describe("#508 review 7: the key sent out is unambiguous", () => {
  test("a business key goes out as a 43-character digest, never as itself, and another key is another digest; a name with a ':' is refused", async ({
    app,
  }) => {
    await execute(app, SendChargeStart, { orderId: "4:2", amountUsd: 10 });
    await execute(app, SendChargeStart, { orderId: "4:3", amountUsd: 10 });

    const keys = gateway.calls.map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^[A-Za-z0-9_-]{43}$/u.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(JSON.stringify(keys)).not.toContain("order");
  });

  it("a name with a ':' — which would make two keys one string — is IdempotencyError.InvalidName", async () => {
    const run = testUnit(BadlyNamedAction);

    await expect(run(order)).rejects.toFailWith(IdempotencyError.InvalidName, {});
  });
});
