/**
 * #626 — what each error of a call that leaves the system says and carries, each field found by a
 * mutant that lived: its name, code, message, details, usage (none: no model ran) and the step it
 * names; the text stored in place of an unmaskable failure.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
} from "../../src/infrastructure/fenced-effect-key.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryOutboundCallRepository } from "../../src/infrastructure/outbound-call.repository.js";
import { OutboundCallSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import { VirtualClock } from "../../src/testing/clock.js";
import {
  OutboundCallReconciliation,
  OutboundCalls,
  OutboundCallInFlightError,
  OutboundCallPart,
  OutboundCallPayloadTooLargeError,
  OutboundCallResultNotStoredError,
  OutboundCallUnmaskedError,
  OutboundCallUnreconciledError,
  REDACTED,
} from "../../src/app/outbound-calls.js";

const CALL = { name: "charge", target: "payments", operation: "charge" };

describe("#626: the outbound call's errors", () => {
  it("OutboundCallUnreconciledError", () => {
    const cause = new Error("lookup failed");
    const error = new OutboundCallUnreconciledError(
      { ...CALL, idempotencyKey: "default:order%3A42:charge", reason: "the lookup timed out" },
      cause,
    );

    expect(error).toMatchObject({
      name: "OutboundCallUnreconciledError",
      code: "outbound-call.unreconciled",
      message:
        'outbound call "charge" (charge on payments, key default:order%3A42:charge) is left pending and could not be reconciled: the lookup timed out — nothing was sent; an operator decides (app.pendingOutboundCalls)',
      call: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: "default:order%3A42:charge",
      reason: "the lookup timed out",
      usage: [],
      cause,
      details: {
        call: "charge",
        target: "payments",
        operation: "charge",
        reason: "the lookup timed out",
      },
    });
    expect(error.usage).toEqual([]);
  });

  it("OutboundCallPayloadTooLargeError", () => {
    const error = new OutboundCallPayloadTooLargeError({
      call: "charge",
      part: OutboundCallPart.Request,
      size: 70_000,
      maxPayloadSize: 65_536,
    });

    expect(error).toMatchObject({
      name: "OutboundCallPayloadTooLargeError",
      code: "outbound-call.payload-too-large",
      message:
        'the request of outbound call "charge" is 70000 bytes, above its maxPayloadSize of 65536 bytes — send and store a reference, or raise @Application({ outboundCalls: { maxPayloadSize } })',
      call: "charge",
      part: OutboundCallPart.Request,
      size: 70_000,
      maxPayloadSize: 65_536,
    });
  });

  it("OutboundCallUnmaskedError", () => {
    expect(new OutboundCallUnmaskedError("charge")).toMatchObject({
      name: "OutboundCallUnmaskedError",
      code: "outbound-call.unmasked",
      message:
        'outbound call "charge" was refused: the application lists PII policies, but this step has no mask to store its request with — nothing was recorded or sent',
      call: "charge",
    });
  });

  it("OutboundCallInFlightError", () => {
    const error = new OutboundCallInFlightError(CALL);

    expect(error).toMatchObject({
      name: "OutboundCallInFlightError",
      code: "outbound-call.in-flight",
      message:
        'outbound call "charge" (charge on payments) is already in flight: another call holds its key and has not ended — nothing was sent',
      call: "charge",
      target: "payments",
      operation: "charge",
      details: { call: "charge", target: "payments", operation: "charge" },
    });
    expect(error.usage).toEqual([]);
  });

  it("OutboundCallResultNotStoredError", () => {
    const error = new OutboundCallResultNotStoredError(CALL, "outbound-call.payload-too-large");

    expect(error).toMatchObject({
      name: "OutboundCallResultNotStoredError",
      code: "outbound-call.result-not-stored",
      message:
        'outbound call "charge" (charge on payments) happened, but its result was not stored (outbound-call.payload-too-large): there is nothing to replay — nothing was sent again; read the result from payments',
      reason: "outbound-call.payload-too-large",
      details: {
        call: "charge",
        target: "payments",
        operation: "charge",
        reason: "outbound-call.payload-too-large",
      },
    });
    expect(error.usage).toEqual([]);
  });

  it("an unmaskable failure's text is stored as [redacted]", () => {
    expect(REDACTED).toBe("[redacted]");
  });
});

describe("#626: send checks a key built by hand first", () => {
  const KEY = {
    scopeKey: "default:execution-1",
    tenantId: "default",
    leaseExecutionId: "execution-1",
    token: 1,
    idempotencyKey: "execution-1:charge-action:1",
    name: "charge",
  };

  function outboundCalls() {
    const [clock, database] = [new VirtualClock(), new InMemoryDatabase()];
    const application = applicationContextOf({
      ...{ name: "keys-application", version: "1.0.0", instanceId: "instance-1" },
      ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
    });
    const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
    return new OutboundCalls(
      new InMemoryOutboundCallRepository(clock, database, leases),
      new OutboundCallSettings(),
    );
  }

  const options = {
    target: "payments",
    operation: "charge",
    request: {},
    send: () => ({}),
    reconcile: () => OutboundCallReconciliation.notSent(),
  };

  it("an invalid name is refused before anything else — even outside a step", async () => {
    await expect(outboundCalls().send({ ...KEY, name: "a:b" }, options)).rejects.toBeInstanceOf(
      InvalidFencedEffectNameError,
    );
  });

  it("an invalid business key is refused before anything else — even outside a step", async () => {
    await expect(
      outboundCalls().send({ ...KEY, businessKey: "order:\u200b42" }, options),
    ).rejects.toBeInstanceOf(InvalidBusinessKeyError);
  });
});
