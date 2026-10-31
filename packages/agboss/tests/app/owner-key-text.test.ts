/**
 * #589 — an owner id is a key's text too: it is stored with the thread and decides who may
 * continue, cancel or answer it, so an id UTF-8 makes another (`bob\uD800` is stored as `bob�` in
 * SQLite and PostgreSQL) must never create a thread another owner then has. Refused at
 * `app.execute`, `app.resume` and `app.cancel` before anything is read or written, as is a
 * `Channel` pause's `answeredBy` (recorded on the pause, in the execution records and read by the
 * model): `dto.invalid` naming the field and the rule, never the id, in the error and its rejection
 * event. Undefined is no owner; anything else that is not a text is refused as `length`.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/errors.js";
import { KeyTextRule, PauseStatus, ThreadOwnerError } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  Clerk,
  OrderWorkflowStart,
  ReceiptDto,
} from "../infrastructure/fixtures/recovery.workflow.js";
import {
  SqliteNoteApplication,
  sqliteFilePerTest,
} from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  ConfirmOrderTool,
  DeskClerkAgent,
  DeskWorkflowFinish,
  DeskWorkflowStart,
  pauseStore,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "../channels/fixtures/pauses.workflow.js";
import { answerFor, approve, askFor, manager } from "../channels/fixtures/pause-scripts.js";
import {
  echoSeen,
  KeyEchoApplication,
  KeyedEffectStart,
  resetEchoSeen,
} from "./fixtures/key-echo.application.js";
import { REFUSED_KEYS } from "./fixtures/key-texts.js";

sqliteFilePerTest();
const sqlite = testWith(SqliteNoteApplication);
const echo = testWith(KeyEchoApplication);
const pauses = testWith(PausesApplication);

beforeEach(() => {
  resetEchoSeen();
  resetPauses();
});

/** What `call` rejected with; `undefined` when it resolved. */
const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The error names the field and the rule, never the id. */
function expectRefused(error: unknown, field: string, rule: KeyTextRule, id: unknown): void {
  expect(error).toBeInstanceOf(DtoValidationError);
  const { message } = error as Error;
  expect(message).toContain(field);
  expect(message).toContain(`(${rule})`);
  if (typeof id === "string" && id.length > 0) expect(message).not.toContain(id);
}

/** Values a JS caller may pass that are no text: refused as `length`, never stored. */
const NOT_TEXTS: readonly (readonly [string, unknown])[] = [
  ["null", null],
  ["a number", 42],
  ["an object", { id: "bob" }],
];

describe("#589 AC1: an owner id breaking a rule is refused at execute, resume and cancel", () => {
  echo.for(REFUSED_KEYS)("%s (%s)", async ([, rule, ownerId], { app }) => {
    const executed = await rejectionOf(
      execute(app, KeyedEffectStart, { text: "order:1" }, { ownerId }),
    );
    const onThread = await rejectionOf(
      execute(app, KeyedEffectStart, { text: "order:1" }, { threadId: "th-1", ownerId }),
    );
    // before the pause or the thread is looked up: not UnknownPauseError / UnknownThreadError
    const resumed = await rejectionOf(
      app.resume({ pauseId: "p-1", decision: { approved: true } }, { ownerId }),
    );
    const cancelled = await rejectionOf(app.cancel("thread-1", { ownerId }));

    for (const error of [executed, onThread, resumed, cancelled])
      expectRefused(error, "ownerId", rule, ownerId);
    expect(echoSeen.ran).toBe(0);
    expect(echoSeen.events).toHaveLength(4);
    for (const event of echoSeen.events) expect(event).toMatchObject({ code: "dto.invalid" });
    if (ownerId.length >= 3)
      expect(JSON.stringify(echoSeen.events)).not.toContain(JSON.stringify(ownerId).slice(1, -1));
  });

  echo.for(NOT_TEXTS)("%s from a JS caller is refused as length", async ([, ownerId], { app }) => {
    const owner = ownerId as string;
    const errors = [
      await rejectionOf(execute(app, KeyedEffectStart, { text: "order:1" }, { ownerId: owner })),
      await rejectionOf(app.resume({ pauseId: "p-1", decision: approve }, { ownerId: owner })),
      await rejectionOf(app.cancel("thread-1", { ownerId: owner })),
    ];

    for (const error of errors) expectRefused(error, "ownerId", KeyTextRule.Length, ownerId);
    expect(echoSeen.ran).toBe(0);
  });

  echo("an owner id that is a key's text runs as before", async ({ app }) => {
    const done = await execute(
      app,
      KeyedEffectStart,
      { text: "order:1" },
      { threadId: "th-1", ownerId: "bob@example.com" },
    );

    expect(done.threadId).toBe("th-1");
    expect(echoSeen.ran).toBe(1);
  });
});

describe("#589 AC1: on SQLite bob\\uD800 creates no thread that bob\\uFFFD then owns", () => {
  sqlite(
    "bob\\uD800 is refused and creates nothing; alice then creates th-1; bob\\uFFFD is another owner",
    async ({ app, mockLlm }) => {
      mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "One." }));
      const at = (ownerId: string) =>
        execute(app, OrderWorkflowStart, { text: "a" }, { threadId: "th-1", ownerId });

      const refused = await rejectionOf(at("bob\uD800"));
      const first = await at("alice");
      const merged = await rejectionOf(at("bob�"));
      const again = await rejectionOf(at("bob\uD800"));

      expectRefused(refused, "ownerId", KeyTextRule.LoneSurrogate, "bob\uD800");
      expect(first.threadId).toBe("th-1");
      expect(merged).toBeInstanceOf(ThreadOwnerError);
      expectRefused(again, "ownerId", KeyTextRule.LoneSurrogate, "bob\uD800");
      await expect(app.cancel("th-1", { ownerId: "alice\uD800" })).rejects.toBeInstanceOf(
        DtoValidationError,
      );
    },
  );
});

describe("#589: who answers a pause is a key's text", () => {
  pauses(
    "a ThreadOwner pause: ownerId alice\\uD800 is refused, it keeps waiting, alice answers it",
    async ({ app, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(
        callTool(ConfirmOrderTool, { orderId: "7" }),
        replyWith("Confirmed."),
      );
      const paused = await execute(
        app,
        DeskWorkflowStart,
        { text: "confirm 7" },
        { ownerId: "alice" },
      );

      const refused = await rejectionOf(
        app.resume(answerOf(paused, approve), { ownerId: "alice\uD800" }),
      );
      const waiting = await pauseStore().findByTenantIdAndPauseId(
        "default",
        paused.pending[0]?.pauseId ?? "",
      );
      const done = await app.resume(answerOf(paused, approve), { ownerId: "alice" });

      expectRefused(refused, "ownerId", KeyTextRule.LoneSurrogate, "alice\uD800");
      expect(waiting?.status).toBe(PauseStatus.Pending);
      expect(done).toFinishWith(DeskWorkflowFinish, { text: "Confirmed." });
    },
  );

  pauses.for(REFUSED_KEYS.filter(([, , text]) => text.trim() !== ""))(
    "a Channel pause: answeredBy with %s (%s) is refused, it keeps waiting, nothing is recorded",
    async ([, rule, answeredBy], { app, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(
        callTool(RefundTool, { orderId: "7" }),
        replyWith("Done."),
      );
      await execute(app, DeskWorkflowStart, { text: "refund 7" }, { ownerId: "alice" });

      const refused = await rejectionOf(app.resume(answerFor("7"), { answeredBy }));
      const stored = await pauseStore().findByTenantIdAndPauseId("default", askFor("7").pauseId);

      expectRefused(refused, "answeredBy", rule, answeredBy);
      expect(stored?.status).toBe(PauseStatus.Pending);
      expect(seen.resumes).toEqual([]);
      expect(await app.resume(answerFor("7"), manager)).toFinishWith(DeskWorkflowFinish, {
        text: "Done.",
      });
    },
  );
});
