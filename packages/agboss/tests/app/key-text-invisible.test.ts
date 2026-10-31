/**
 * #556 AC1 — the four rules of #556 at the entry points the shared tables do not reach elsewhere: a
 * tenant id at `app.execute`, `app.resume` and `app.cancel`, and `app.cancel`'s thread id
 * (`fencedEffectKeyOf`, a thread id at `app.execute` and `OutboundCalls.send` run every row of
 * `REFUSED_KEYS` in key-text-rules / key-text.acceptance). Each refusal names its rule, never the
 * text, and nothing runs.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/dto/errors.js";
import { InvalidThreadIdError, KeyTextRule } from "../../src/errors.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  echoSeen,
  KeyEchoApplication,
  KeyedEffectStart,
  resetEchoSeen,
} from "./fixtures/key-echo.application.js";
import { REFUSED_KEYS } from "./fixtures/key-texts.js";

const echo = testWith(KeyEchoApplication);

beforeEach(() => {
  resetEchoSeen();
});

const RULES_556 = new Set<KeyTextRule>([
  KeyTextRule.Ignorable,
  KeyTextRule.PrivateOrNoncharacter,
  KeyTextRule.Unassigned,
  KeyTextRule.Blank,
]);

const ROWS = REFUSED_KEYS.filter(([, rule]) => RULES_556.has(rule));

const rejectionOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#556 AC1: a tenant id and a cancel's thread id", () => {
  echo("every #556 class has rows", () => {
    expect(new Set(ROWS.map(([, rule]) => rule))).toEqual(RULES_556);
  });

  echo.for(ROWS)("%s (%s)", async ([, rule, text], { app }) => {
    const tenantRefusals = [
      await rejectionOf(
        execute(app, KeyedEffectStart, { text: "order:1" }, { tenant: { tenantId: text } }),
      ),
      await rejectionOf(
        app.resume(
          { pauseId: "p-1", decision: { approved: true } },
          { tenantId: text, ownerId: "a" },
        ),
      ),
      await rejectionOf(app.cancel("thread-1", { tenantId: text })),
    ];
    const cancelled = await rejectionOf(app.cancel(text));

    for (const error of tenantRefusals) {
      expect(error).toBeInstanceOf(DtoValidationError);
      expect((error as Error).message).toContain("tenantId");
      expect((error as Error).message).toContain(`(${rule})`);
      expect((error as Error).message).not.toContain(text);
    }
    expect(cancelled).toBeInstanceOf(InvalidThreadIdError);
    expect(cancelled).toMatchObject({ rule });
    expect((cancelled as Error).message).not.toContain(text);
    expect(echoSeen.ran).toBe(0);
    expect(JSON.stringify(echoSeen.events)).not.toContain(JSON.stringify(text).slice(1, -1));
  });
});
