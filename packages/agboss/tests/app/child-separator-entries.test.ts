/**
 * #1321d: a thread id that holds the child separator is refused at every entry that takes one —
 * `app.execute`, `app.cancel`, `app.stop`, `app.pause`, `app.unpause` — with `InvalidThreadIdError`
 * naming `reserved-separator`, never the id; nothing runs and nothing is written for it.
 */
import { describe, expect, it } from "vitest";
import { InvalidThreadIdError, KeyTextRule } from "../../src/errors.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { ChatStart, DeskApplication } from "../testing/fixtures/desk.workflow.js";

const EVIL = "root/child/x-evil";
const app = testWith(DeskApplication);

const rejectionOf = (call: () => Promise<unknown>): Promise<unknown> =>
  call().then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1321d: a thread id with the child separator, at every entry", () => {
  app("is refused by execute, cancel, stop, pause and unpause", async ({ app: running }) => {
    const refusals = [
      await rejectionOf(() => execute(running, ChatStart, { text: "hi" }, { threadId: EVIL })),
      await rejectionOf(() => running.cancel(EVIL)),
      await rejectionOf(() => running.stop(EVIL)),
      await rejectionOf(() => running.pause(EVIL)),
      await rejectionOf(() => running.unpause(EVIL)),
    ];

    for (const error of refusals) {
      expect(error).toBeInstanceOf(InvalidThreadIdError);
      expect(error).toMatchObject({ rule: KeyTextRule.ReservedSeparator });
      expect((error as Error).message).not.toContain("x-evil");
    }
  });
});
