/**
 * #824 (mutation shard `a2a-server`): a follow-up's outcome on its own — each refusal's error and
 * fixed text, a kept reply told from anything else, and how a resume that threw is read: refused
 * before its pause took the answer, accepted after it (logged), or — an unexpected failure, its
 * pause still pending — the request failed (logged).
 */
import { describe, expect, it } from "vitest";
import {
  isKeptReply,
  refusalOf as wireRefusalOf,
  settledOutcome,
  type KeptReply,
} from "../../../src/a2a/server/a2a-follow-up-outcome.js";
import { UnknownPauseError } from "../../../src/run/resume-agent.js";
import { PauseClosedReason } from "../../../src/infrastructure/pause-record.js";
import {
  ReplyInterpreterMissingError,
  UninterpretableReplyError,
} from "../../../src/channels/decision.js";
import { DtoValidationError } from "../../../src/dto/errors.js";
import { NotPausedError } from "../../../src/run/resume-agent.js";
import { ThreadOwnerError } from "../../../src/core/errors.js";
import { scriptOf, unitParts } from "./support/unit-parts.js";

type Refusal = Exclude<KeptReply, { readonly accepted: true }>;

const KEY = { tenantId: "acme", taskId: "task-1" };
const SUBJECT = JSON.stringify({ tenantId: "acme", executionId: "task-1" });

/** A wire refusal as its class, its code and its text. */
const shown = (refusal: Refusal): string => {
  const error = wireRefusalOf(refusal);
  const metadata = Reflect.get(error, "metadata") as { code?: string } | undefined;
  return `${error.name} ${String(metadata?.code)}: ${error.message}`;
};

describe("#824: a follow-up's refusal on the wire", () => {
  it("each code with its fixed text, as -32602 or -32004", () => {
    const of = (refused: Refusal["refused"], code: string) => shown({ refused, code });

    expect([
      of("unsupported", "a2a.no-pending-pause"),
      of("invalid-params", "a2a.pause-required"),
      of("invalid-params", "a2a.unknown-pause"),
      of("unsupported", "a2a.already-answered"),
      of("invalid-params", "a2a.reply-not-understood"),
      of("invalid-params", "a2a.decision-invalid"),
      of("unsupported", "a2a.task-over"),
      of("invalid-params", "a2a.other"),
    ]).toEqual([
      "UnsupportedOperationError a2a.no-pending-pause: the task waits for no answer of yours",
      "RequestMalformedError a2a.pause-required: name the pause to answer",
      "RequestMalformedError a2a.unknown-pause: the task waits for no such pause",
      "UnsupportedOperationError a2a.already-answered: the pause no longer waits for an answer",
      "RequestMalformedError a2a.reply-not-understood: the reply was not understood",
      "RequestMalformedError a2a.decision-invalid: the decision does not fit the pause",
      "UnsupportedOperationError a2a.task-over: the task is over: it takes no more input",
      "RequestMalformedError a2a.other: the answer was refused",
    ]);
  });

  it("a closed pause's refusal needs its code, its reason and its time: without any, the generic one; with all, the reason's text and metadata", () => {
    const CLOSED_AT = "2026-01-05T09:00:00.000Z";
    const wire = (refusal: Refusal) => {
      const error = wireRefusalOf(refusal);
      return { message: error.message, metadata: Reflect.get(error, "metadata") as unknown };
    };
    const base = { refused: "unsupported", code: "a2a.pause-closed" } as const;

    expect(wire({ ...base, reason: PauseClosedReason.Expired, closedAt: CLOSED_AT })).toEqual({
      message: "the pause expired",
      metadata: { code: "a2a.pause-closed", reason: "expired", closedAt: CLOSED_AT },
    });
    for (const incomplete of [
      base,
      { ...base, reason: PauseClosedReason.Expired },
      { ...base, closedAt: CLOSED_AT },
    ])
      expect(wire(incomplete)).toEqual({
        message: "the answer was refused",
        metadata: { code: "a2a.pause-closed" },
      });
    // another code with a reason and a time is no closed pause
    expect(
      wire({
        refused: "unsupported",
        code: "a2a.task-over",
        reason: PauseClosedReason.Expired,
        closedAt: CLOSED_AT,
      }),
    ).toEqual({
      message: "the task is over: it takes no more input",
      metadata: { code: "a2a.task-over" },
    });
  });

  it("another owner's task is not found, like none", () => {
    expect(shown({ refused: "not-found", code: "a2a.not-owner" })).toBe(
      "TaskNotFoundError undefined: task not found",
    );
  });

  it("a kept reply is an acceptance or a refusal object; nothing else is", () => {
    expect([
      isKeptReply({ accepted: true }),
      isKeptReply({ refused: "unsupported", code: "x" }),
      isKeptReply({}),
      isKeptReply(null),
      isKeptReply("refused"),
      isKeptReply(undefined),
    ]).toEqual([true, true, false, false, false, false]);
  });
});

describe("#824: a resume that settled", () => {
  const outcomeOf = (error: unknown, isStillPending: boolean) => {
    const script = scriptOf();
    const outcome = settledOutcome(unitParts(script), KEY, { error }, isStillPending);
    return { outcome, script };
  };

  it("no failure: accepted", () => {
    expect(settledOutcome(unitParts(scriptOf()), KEY, undefined, true)).toEqual({ accepted: true });
  });

  it("refused before its pause took the answer, whether the pause still waits or not", () => {
    const reply = new UninterpretableReplyError({ message: "x", reason: "r" });
    for (const isStillPending of [true, false])
      expect(
        [
          new NotPausedError({ message: "x" }),
          new UnknownPauseError({ message: "x" }),
          new ThreadOwnerError({ message: "x" }),
          reply,
          new ReplyInterpreterMissingError({ message: "x" }),
        ].map((error) => outcomeOf(error, isStillPending).outcome),
      ).toEqual([
        { refused: "unsupported", code: "a2a.no-pending-pause" },
        { refused: "invalid-params", code: "a2a.unknown-pause" },
        { refused: "not-found", code: "a2a.not-owner" },
        { refused: "invalid-params", code: "a2a.reply-not-understood" },
        { refused: "invalid-params", code: "a2a.reply-not-understood" },
      ]);
  });

  it("an invalid decision, its pause still waiting: refused; the pause gone: the answer was taken", () => {
    const invalid = new DtoValidationError({ dto: "Decision", issues: [] });

    expect(outcomeOf(invalid, true).outcome).toEqual({
      refused: "invalid-params",
      code: "a2a.decision-invalid",
    });
    const taken = outcomeOf(invalid, false);
    expect(taken.outcome).toEqual({ accepted: true });
    expect(taken.script.warnings).toEqual([
      `a2a.resume-failed-after-answer a resume of task task-1 failed (DtoValidationError) after it took its answer ${SUBJECT}`,
    ]);
  });

  it("any other failure after its pause took the answer: accepted, logged; before: the request failed, logged", () => {
    const after = outcomeOf("thrown text", false);
    const script = scriptOf();
    const before = () =>
      settledOutcome(unitParts(script), KEY, { error: new RangeError("x") }, true);

    expect(after.outcome).toEqual({ accepted: true });
    expect(after.script.warnings).toEqual([
      `a2a.resume-failed-after-answer a resume of task task-1 failed (string) after it took its answer ${SUBJECT}`,
    ]);
    expect(before).toThrow("the request failed");
    expect(script.errors).toEqual([
      `a2a.resume-failed a resume of task task-1 failed (RangeError) before it took its answer ${SUBJECT}`,
    ]);
    expect(script.warnings).toEqual([]);
  });
});
