import { expect } from "vitest";
import { VCRMode, testWith } from "@agboss/core/testing";
import { DeskAnswerWorkflowFinish } from "../../../../src/desk/workflows/desk/desk-answer.workflow-finish.js";
import { DeskWorkflowStart } from "../../../../src/desk/workflows/desk/desk.workflow-start.js";
import { DeskApplication } from "../../../../src/desk.application.js";

/**
 * A recorded run (VCR, cassette version 2): the desk's two model calls, recorded once from the
 * offline transport
 * (`AGBOSS_VCR_MODE=RECORD npx vitest run tests/desk/workflows/desk/desk-cassette.test.ts`) and
 * replayed here — no script, no key, no network. Each call keeps its component's prompt and schema
 * hashes, so `agboss check --cassettes` (in `npm run check`) fails once the desk's prompt changes.
 */

const test = testWith(DeskApplication, {
  vcr: {
    cassetteName: "desk-lookup",
    dir: "tests/desk/workflows/desk/__snapshots__",
    mode: VCRMode.REPLAY,
  },
});

test("the desk's recorded answer replays", async ({ app }) => {
  const result = await app.execute(DeskWorkflowStart, {
    customerId: "c-1",
    question: "Where is order #7?",
  });

  expect(result).toFinishWith(DeskAnswerWorkflowFinish, {
    text: 'It says: {"status":"order 7 shipped on Monday"}',
  });
});
