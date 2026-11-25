import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
/**
 * #626 — what each error of a call that leaves the system says and carries, each field found by a
 * mutant that lived: its name, code, message, details; the text stored in place of an unmaskable failure.
 */
import { describe, expect, it } from "vitest";
import { OutboundRecovery, Reconciliation } from "../../src/index.js";
import {
  inFlightError,
  payloadTooLargeError,
  REDACTED,
  resultNotStoredError,
  unmaskedError,
  unreconciledError,
} from "../../src/app/outbound-call-errors.js";
import type { Bytes } from "../../src/units/index.js";
import { outboundFrame, type OutboundSendCase } from "../helpers/outbound-frame.js";

const CALL = { call: "charge", target: "payments", operation: "charge" };

describe("#626: the outbound call's errors", () => {
  it("OutboundCallError.Unreconciled", () => {
    const cause = new Error("lookup failed");
    const error = unreconciledError({
      ...CALL,
      idempotencyKey: "kozeA6UXkFQOmJlRz1_iDumLcer6Ops_OXo1PjSvjAw",
      reason: "reconcile.unknown",
      detail: "the lookup timed out",
      cause,
    });

    expect(error).toMatchObject({
      name: "OutboundCallError.Unreconciled",
      code: "outbound-call.unreconciled",
      message:
        'outbound call "charge" (charge on payments, key kozeA6UXkFQOmJlRz1_iDumLcer6Ops_OXo1PjSvjAw) is left pending and could not be reconciled (reconcile.unknown): the lookup timed out — nothing was sent; an operator decides (app.listOutboundCalls)',
      call: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: "kozeA6UXkFQOmJlRz1_iDumLcer6Ops_OXo1PjSvjAw",
      reason: "reconcile.unknown",
      detail: "the lookup timed out",
      cause,
      details: {
        call: "charge",
        target: "payments",
        operation: "charge",
        reason: "reconcile.unknown",
        detail: "the lookup timed out",
      },
    });
  });

  it("OutboundCallError.PayloadTooLarge", () => {
    const error = payloadTooLargeError({
      call: "charge",
      part: "request",
      size: 70_000 as Bytes,
      maxPayloadSize: 65_536 as Bytes,
    });

    expect(error).toMatchObject({
      name: "OutboundCallError.PayloadTooLarge",
      code: "outbound-call.payload-too-large",
      message:
        'the request of outbound call "charge" is 70000 bytes, above its maxPayloadSize of 65536 bytes — send and store a reference, or raise maxPayloadSize of sendOnce',
      call: "charge",
      part: "request",
      size: 70_000,
      maxPayloadSize: 65_536,
    });
  });

  it("OutboundCallError.Unmasked", () => {
    expect(unmaskedError("charge")).toMatchObject({
      name: "OutboundCallError.Unmasked",
      code: "outbound-call.unmasked",
      message:
        'outbound call "charge" was refused: the application lists PII policies, but this step has no mask to store its request with — nothing was recorded or sent',
      call: "charge",
    });
  });

  it("OutboundCallError.InFlight", () => {
    const error = inFlightError(CALL);

    expect(error).toMatchObject({
      name: "OutboundCallError.InFlight",
      code: "outbound-call.in-flight",
      message:
        'outbound call "charge" (charge on payments) is already in flight: another call holds its key and has not ended — nothing was sent',
      call: "charge",
      target: "payments",
      operation: "charge",
      details: { call: "charge", target: "payments", operation: "charge" },
    });
  });

  it("OutboundCallError.ResultNotStored", () => {
    const error = resultNotStoredError({
      ...CALL,
      reason: "outbound-call.payload-too-large",
    });

    expect(error).toMatchObject({
      name: "OutboundCallError.ResultNotStored",
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
  });

  it("an unmaskable failure's text is stored as [redacted]", () => {
    expect(REDACTED).toBe("[redacted]");
  });
});

describe("#626: sendOnce checks the name and the business key first", () => {
  const KEY = effectKeyForTesting({
    scopeKey: "default:execution-1",
    tenantId: "default",
    leaseExecutionId: "execution-1",
    token: 1,
    idempotencyKey: "execution-1:charge-action:1",
    name: "charge",
  });

  const options: OutboundSendCase<object, object> = {
    target: "payments",
    operation: "charge",
    request: {},
    send: () => ({}),
    recovery: OutboundRecovery.permanentLookup(() => Reconciliation.notExecuted()),
  };

  it("an invalid name is refused before anything else", async () => {
    const frame = outboundFrame();

    await expect(
      frame.send(effectKeyForTesting(KEY, { name: "a:b" }), options),
    ).rejects.toBeInstanceOf(IdempotencyError.InvalidName);
  });

  it("an invalid business key is refused before anything else", async () => {
    const frame = outboundFrame();

    await expect(
      frame.send(effectKeyForTesting(KEY, { businessKey: "order:\u200b42" }), options),
    ).rejects.toBeInstanceOf(IdempotencyError.InvalidKey);
  });
});
