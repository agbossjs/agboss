/**
 * #508 AC1–AC3 — business idempotency keys: one charge per order (`order:<id>`) whatever tool call,
 * step, execution or thread makes it. The model calling the charge tool twice charges once; two
 * executions on two threads charge once; the same order with another amount is refused with
 * `IdempotencyKeyConflictError` and nothing is charged — through the fenced effect, the tool and
 * `OutboundCalls`. An invalid key is refused before anything runs, and no error carries the key.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseEventKind,
  FencedEffectStatus,
  IdempotencyKeyConflictError,
  InvalidBusinessKeyError,
  OutboundCallInFlightError,
  OutboundCallOutcomeStatus,
  OutboundCallUnreconciledError,
  ToolCallStatus,
} from "../../src/index.js";
import {
  callTool,
  callTools,
  replyWith,
  TestConcurrency,
  testWith,
} from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { withInstancePiiKeys } from "../../src/testing/pii-parts.js";
import { TEST_PSEUDONYM_KEY } from "../../src/pii/application-key.js";
import { keyedDigestOf, tokenOf } from "../../src/pii/tokens.js";
import { BUSINESS_KEY_HANDLE_LABEL } from "../../src/infrastructure/fenced-effect-key.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, settle } from "./fixtures/fence-takeover.js";
import { execute } from "../helpers/flow.js";
import {
  BusinessKeyApplication,
  CashierAgent,
  CashierStart,
  ChargeOrderStart,
  ChargeOrderTool,
  ledger,
  letLedgerGo,
  resetLedger,
  SendChargesStart,
  SendChargeStart,
  SendChargeTool,
} from "./fixtures/business-key.workflow.js";
import { gateway, LookupMode, resetGateway } from "./fixtures/payment-gateway.js";

const test = testWith(BusinessKeyApplication);
const real = testWith(BusinessKeyApplication, { concurrency: TestConcurrency.Real });
const two = testWith(BusinessKeyApplication, { instances: 2 });

beforeEach(() => {
  resetLedger();
  resetGateway();
  resetRecovery();
});

afterEach(() => {
  letLedgerGo();
});

/** Every message and serialized form along `error`'s cause chain. */
function chainTextOf(error: unknown): string {
  const parts: string[] = [];
  for (let at: unknown = error; at instanceof Error; at = at.cause)
    parts.push(at.message, JSON.stringify(at));
  return parts.join("\n");
}

/** Until `count` outbound charges are frozen before they are sent. */
async function frozenCharges(count: number): Promise<void> {
  for (let tick = 0; tick < 2000 && ledger.frozen.length < count; tick += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (ledger.frozen.length < count) throw new Error(`${String(count)} charges never froze`);
}

describe("#508 AC1: the model calls the charge tool twice", () => {
  test("AC1: the model calls the charge tool twice for one order → charged once, second call Replayed", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(CashierAgent).thenReturn(
      callTool(ChargeOrderTool, { orderId: "42", amountUsd: 10 }),
      callTool(ChargeOrderTool, { orderId: "42", amountUsd: 10 }),
      replyWith("Charged."),
    );

    const result = await execute(app, CashierStart, { text: "charge order 42, $10" });

    expect(ledger.charges).toEqual([{ orderId: "42", amountUsd: 10 }]);
    expect(ledger.effects).toEqual([FencedEffectStatus.Ran, FencedEffectStatus.Replayed]);
    expect(result.toolCalls.map((call) => call.output)).toEqual([
      { chargeId: "charge-42-1" },
      { chargeId: "charge-42-1" },
    ]);
  });

  test("AC3: the model charges the same order with another amount → the second call fails with the conflict, nothing more charged", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(CashierAgent).thenReturn(
      callTool(ChargeOrderTool, { orderId: "42", amountUsd: 10 }),
      callTool(ChargeOrderTool, { orderId: "42", amountUsd: 12 }),
      replyWith("The second charge was refused."),
    );

    const result = await execute(app, CashierStart, { text: "charge order 42" });

    expect(ledger.charges).toEqual([{ orderId: "42", amountUsd: 10 }]);
    expect(result.toolCalls.map((call) => call.status)).toEqual([
      ToolCallStatus.Succeeded,
      ToolCallStatus.Failed,
    ]);
    expect(result.toolCalls[1]?.error).toMatchObject({ code: "fenced-effect.key-conflict" });
    expect(JSON.stringify(result.toolCalls[1])).not.toContain("order:42");
  });
});

describe("#508 AC2: two executions on two threads", () => {
  test("AC2: two executions on two threads for one order → charged once (fenced effect), the second names the first", async ({
    app,
  }) => {
    const first = await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 10 });
    const second = await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 10 });

    expect(first.threadId).not.toBe(second.threadId);
    expect(ledger.charges).toHaveLength(1);
    expect(second.output).toEqual(first.output);
    expect(ledger.effects).toEqual([FencedEffectStatus.Ran, FencedEffectStatus.Replayed]);
    const rows = await app.leaseEventsOf({
      tenantId: "default",
      rootExecutionId: second.executionId,
    });
    expect(rows.filter((row) => row.kind === ExecutionLeaseEventKind.FencedEffect)).toEqual([
      expect.objectContaining({
        replayedFrom: {
          executionId: first.executionId,
          nodeId: "charge-order-action",
          visitNumber: 1,
        },
      }),
    ]);
  });

  test("AC2: two executions on two threads for one order → charged once (outbound call), one provider call", async ({
    app,
  }) => {
    const first = await execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 });
    const second = await execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 });

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.idempotencyKey).toBe("default:order%3A42:charge");
    expect(second.output).toEqual(first.output);
    expect(ledger.outbound).toEqual([
      OutboundCallOutcomeStatus.Sent,
      OutboundCallOutcomeStatus.Replayed,
    ]);
    const calls = await app.outboundCallsOf({
      tenantId: "default",
      rootExecutionId: first.executionId,
    });
    // an operator's read shows the business key by its handle only (#508)
    expect(calls).toEqual([
      expect.objectContaining({
        businessKeyHash: TEST_KEYED,
        idempotencyKey: `business-key:${TEST_KEYED}:charge`,
      }),
    ]);
    expect(JSON.stringify(calls)).not.toContain("order:42");
    expect(JSON.stringify(calls)).not.toContain("order%3A42");
  });
});

describe("#508 AC3: the same order with another amount", () => {
  test("AC3: the same order with another amount → IdempotencyKeyConflictError, nothing charged (fenced effect)", async ({
    app,
  }) => {
    await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 10 });

    await expect(
      execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 12 }),
    ).rejects.toFailWith(IdempotencyKeyConflictError, { effect: "charge" });
    expect(ledger.charges).toEqual([{ orderId: "42", amountUsd: 10 }]);
  });

  test("AC3: the same order with another amount → IdempotencyKeyConflictError, nothing sent (outbound call)", async ({
    app,
  }) => {
    await execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 });

    await expect(
      execute(app, SendChargeStart, { orderId: "42", amountUsd: 12 }),
    ).rejects.toFailWith(IdempotencyKeyConflictError, { effect: "charge" });
    expect(gateway.calls).toHaveLength(1);
  });

  test("AC3: a concurrent call with another fingerprint under one business key is refused, not joined", async ({
    app,
  }) => {
    ledger.freeze = 1;
    const first = execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 });
    await frozenCharges(1);

    const refused = execute(app, SendChargeStart, { orderId: "42", amountUsd: 12 });

    await expect(refused).rejects.toFailWith(IdempotencyKeyConflictError, { effect: "charge" });
    letLedgerGo();
    await expect(first).resolves.toMatchObject({ output: { chargeId: "ch-42-1" } });
    expect(gateway.calls).toHaveLength(1);
  });

  test("AC3: the conflict's message and its serialized form carry no business key, only its hash", async ({
    app,
  }) => {
    await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 10 });

    const error = await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 12 }).catch(
      (thrown: unknown) => thrown,
    );

    expect(chainTextOf(error)).not.toContain("order:42");
    let conflict: unknown = error;
    while (conflict instanceof Error && !(conflict instanceof IdempotencyKeyConflictError))
      conflict = conflict.cause;
    expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(conflict).toMatchObject({ businessKeyHash: expect.stringMatching(/^[0-9a-f]{12}$/u) });
  });
});

describe("#508: a pending call under a business key", () => {
  test("in flight in another execution of this instance: joined — the first charge, one provider call", async ({
    app,
  }) => {
    ledger.freeze = 1;
    const first = execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 });
    await frozenCharges(1);

    const second = execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 });
    await settle(); // the second execution reaches its call and joins the first
    letLedgerGo();

    expect((await second).output).toEqual((await first).output);
    expect(ledger.outbound).toEqual([
      OutboundCallOutcomeStatus.Sent,
      OutboundCallOutcomeStatus.Joined,
    ]);
    expect(gateway.calls).toHaveLength(1);
  });

  two(
    "in flight on another instance whose lease is alive: OutboundCallInFlightError, nothing sent",
    async ({ apps }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      ledger.freeze = 1;
      const first = execute(a, SendChargeStart, { orderId: "42", amountUsd: 10 });
      await frozenCharges(1);

      await expect(
        execute(b, SendChargeStart, { orderId: "42", amountUsd: 10 }),
      ).rejects.toFailWith(OutboundCallInFlightError, { call: "charge" });
      letLedgerGo();
      await first;
      expect(gateway.calls).toHaveLength(1);
    },
  );

  test("left pending by an execution whose lease is gone: the next execution reconciles it and sends it once", async ({
    app,
  }) => {
    ledger.freeze = 1;
    const first = execute(
      app,
      SendChargeStart,
      { orderId: "42", amountUsd: 10 },
      {
        threadId: "thread-first",
      },
    );
    first.catch(() => undefined);
    await frozenCharges(1);
    await app.cancel("thread-first", { tenantId: "default" });
    await first.catch(() => undefined);

    const second = await execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 });

    expect(ledger.outbound).toEqual([OutboundCallOutcomeStatus.Sent]);
    expect(gateway.lookups).toEqual([{ idempotencyKey: "default:order%3A42:charge", attempt: 1 }]);
    expect(gateway.calls).toEqual([{ idempotencyKey: "default:order%3A42:charge", attempt: 2 }]);
    expect(second.output).toEqual({ chargeId: "ch-42-1" });
  });
});

describe("#508: an invalid business key", () => {
  const INVALID = [
    ["too long", "x".repeat(200)],
    ["a control character", "4\n2"],
  ] as const;

  for (const [what, orderId] of INVALID)
    test(`${what}: InvalidBusinessKeyError before anything runs, the key not in the error`, async ({
      app,
    }) => {
      const error = await execute(app, ChargeOrderStart, { orderId, amountUsd: 10 }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(Error);
      await expect(Promise.reject(error as Error)).rejects.toFailWith(InvalidBusinessKeyError, {});
      expect(chainTextOf(error)).not.toContain(`order:${orderId}`);
      expect(ledger.charges).toEqual([]);
    });
});

describe("#508: one owner per attempt — calls of one execution never race", () => {
  real(
    "AC1: two parallel tool calls in one execution charging one business key → one send, the other Joined",
    async ({ app, mockLlm }) => {
      const charge = { orderId: "42", amountUsd: 10 };
      mockLlm(CashierAgent).thenReturn(
        callTools(callTool(SendChargeTool, charge), callTool(SendChargeTool, charge)),
        replyWith("Charged once."),
      );

      const result = await execute(app, CashierStart, { text: "charge order 42 twice, quickly" });

      expect(gateway.calls).toHaveLength(1);
      expect([...ledger.outbound].sort()).toEqual([
        OutboundCallOutcomeStatus.Joined,
        OutboundCallOutcomeStatus.Sent,
      ]);
      expect(result.toolCalls.map((call) => call.output)).toEqual([
        { chargeId: "ch-42-1" },
        { chargeId: "ch-42-1" },
      ]);
    },
  );

  real(
    "two branches of one tree on one business key → one send, the other Joined",
    async ({ app }) => {
      const charge = { orderId: "42", amountUsd: 10 };

      const result = await execute(app, SendChargesStart, [charge, charge]);

      expect(gateway.calls).toHaveLength(1);
      expect([...ledger.outbound].sort()).toEqual([
        OutboundCallOutcomeStatus.Joined,
        OutboundCallOutcomeStatus.Sent,
      ]);
      expect(result.output).toEqual({ chargeIds: "ch-42-1, ch-42-1" });
    },
  );

  two(
    "a dead owner in the same execution, after a crash and its recovery → reconciled once, sent once",
    async ({ apps, clock, leases }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await Promise.all([a.ready(), b.ready()]);
      ledger.freeze = 1;
      const dying = execute(a, SendChargeStart, { orderId: "42", amountUsd: 10 });
      dying.catch(() => undefined);
      await frozenCharges(1);
      // A recorded the intent and froze before sending; B's sweep takes the tree over
      leases.stall(a);
      await clock.advance(seconds(31));
      await clock.advance(seconds(31));
      const [end] = await ends(1);

      expect(gateway.lookups).toEqual([
        { idempotencyKey: "default:order%3A42:charge", attempt: 1 },
      ]);
      expect(gateway.calls).toEqual([{ idempotencyKey: "default:order%3A42:charge", attempt: 2 }]);
      expect(end?.output).toEqual({ chargeId: "ch-42-1" });
      leases.resume(a);
    },
  );
});

describe("#508: a business key never leaves in an error", () => {
  test("an unreconciled call under a business key names its key by hash only", async ({ app }) => {
    ledger.freeze = 1;
    const first = execute(
      app,
      SendChargeStart,
      { orderId: "42", amountUsd: 10 },
      {
        threadId: "thread-first",
      },
    );
    first.catch(() => undefined);
    await frozenCharges(1);
    await app.cancel("thread-first", { tenantId: "default" });
    await first.catch(() => undefined);
    gateway.lookup = LookupMode.Unknown;

    const error = await execute(app, SendChargeStart, { orderId: "42", amountUsd: 10 }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    await expect(Promise.reject(error as Error)).rejects.toFailWith(OutboundCallUnreconciledError, {
      idempotencyKey: expect.stringMatching(/^business-key:[0-9a-f]{12}:charge$/u) as unknown,
    });
    expect(chainTextOf(error)).not.toContain("order:42");
    expect(gateway.calls).toEqual([]);
  });
});

describe("#508: two instances racing on one business key", () => {
  two(
    "two executions on two instances racing on one Failed business-key intent → exactly one send",
    async ({ apps }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      gateway.failNext = 1;
      await expect(execute(a, SendChargeStart, { orderId: "42", amountUsd: 10 })).rejects.toThrow(
        "card declined",
      );

      const outcomes = await Promise.allSettled([
        execute(a, SendChargeStart, { orderId: "42", amountUsd: 10 }),
        execute(b, SendChargeStart, { orderId: "42", amountUsd: 10 }),
      ]);

      expect(gateway.calls.map((call) => call.attempt)).toEqual([1, 2]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).not.toHaveLength(0);
      expect(ledger.outbound.filter((status) => status === OutboundCallOutcomeStatus.Sent)).toEqual(
        [OutboundCallOutcomeStatus.Sent],
      );
    },
  );
});

/** The conflict at the end of `error`'s cause chain. */
function conflictOf(error: unknown): IdempotencyKeyConflictError {
  for (let at: unknown = error; at instanceof Error; at = at.cause)
    if (at instanceof IdempotencyKeyConflictError) return at;
  throw new Error("no IdempotencyKeyConflictError in the chain");
}

/** The conflict of charging order 42 for $10, then $12, on `app`. */
async function conflictOn(
  app: Parameters<typeof execute>[0],
): Promise<IdempotencyKeyConflictError> {
  await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 10 });
  const error = await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 12 }).catch(
    (thrown: unknown) => thrown,
  );
  return conflictOf(error);
}

const UNKEYED = createHash("sha256").update("order:42").digest("hex");
/** order:42's handle under the test's fixed PII key: under its own subkey, its input prefixed. */
const HANDLE_KEY = keyedDigestOf(TEST_PSEUDONYM_KEY, BUSINESS_KEY_HANDLE_LABEL);
const TEST_KEYED = keyedDigestOf(HANDLE_KEY, "business-key\u0000order:42").slice(0, 12);

describe("#508: a business key's handle is keyed", () => {
  const perExecution = testWith(BusinessKeyApplication, withInstancePiiKeys({}));

  test("the same business key gives the same handle within one application", async ({ app }) => {
    const first = await conflictOn(app);
    const again = conflictOf(
      await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 14 }).catch(
        (thrown: unknown) => thrown,
      ),
    );

    expect(first.businessKeyHash).toBe(TEST_KEYED);
    expect(again.businessKeyHash).toBe(first.businessKeyHash);
  });

  test("the message has neither the raw key nor its unkeyed SHA-256", async ({ app }) => {
    const conflict = await conflictOn(app);

    const text = `${conflict.message}\n${JSON.stringify(conflict)}`;
    expect(text).not.toContain("order:42");
    expect(text).not.toContain(UNKEYED.slice(0, 12));
    expect(conflict.businessKeyHash).not.toBe(UNKEYED.slice(0, 12));
  });

  test("the handle of a value never equals the PII token of that value under the same key", async ({
    app,
  }) => {
    const conflict = await conflictOn(app);
    const token = tokenOf("text", "order:42", TEST_PSEUDONYM_KEY, {});
    const plainHmac = keyedDigestOf(TEST_PSEUDONYM_KEY, "order:42");

    expect(conflict.businessKeyHash).toBe(TEST_KEYED);
    expect(token).not.toContain(String(conflict.businessKeyHash));
    expect(plainHmac.startsWith(String(conflict.businessKeyHash))).toBe(false);
  });

  perExecution(
    "another PII key gives another handle: each execution's own key (#334) against the test's",
    async ({ app }) => {
      const conflict = await conflictOn(app);
      const another = conflictOf(
        await execute(app, ChargeOrderStart, { orderId: "42", amountUsd: 14 }).catch(
          (thrown: unknown) => thrown,
        ),
      );

      expect(conflict.businessKeyHash).toMatch(/^[0-9a-f]{12}$/u);
      expect(conflict.businessKeyHash).not.toBe(TEST_KEYED);
      expect(another.businessKeyHash).not.toBe(conflict.businessKeyHash);
    },
  );
});
