/**
 * #1325a security: a failure rebuilt from a record (`RecordedError`, an `AGBossError`) whose original was a
 * third-party SDK's error reaches the wire through a real `a2aHttpListener` as `internal` with the fixed
 * text — never the original's code, name or message — while a recorded framework error keeps its code. An
 * action's `AGBossError` is not wrapped by its step, so the recorded error is the task's own failure.
 */
import { describe, expect } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import {
  CARD_SECRET,
  FamilyRouteA2AExpose,
  FamilyRouteServedApplication,
} from "../../errors/family-routing.fixtures.js";
import { BearerAuthenticator } from "../fixtures/bearer-authenticator.js";
import { data, rpc, userMessage } from "./rpc.js";

const test = testWith(FamilyRouteServedApplication);
const listener = { expose: FamilyRouteA2AExpose, authenticator: BearerAuthenticator };
const send = (messageId: string, fail: string) => ({
  message: userMessage(messageId, [data({ fail })], {
    metadata: { "https://agboss.dev/a2a/skills/v1": { skill: "family-route-workflow-start" } },
  }),
});
const statusOf = (answer: Awaited<ReturnType<typeof rpc>>) =>
  (answer.body.result as { task: { status: unknown } }).task.status;

describe("#1325a: a recorded failure on the wire", () => {
  test("a recorded third-party error is `internal` with the fixed text, nothing of the original", async ({
    a2aServer,
  }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(url, "SendMessage", send("m-1", "recorded-third-party"));

    expect(statusOf(answer)).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: { parts: [{ text: "the task failed" }] },
    });
    expect(JSON.stringify(answer.body)).not.toMatch(/alice|4242|sk_live|StripeCard|card_declined/);
    expect(JSON.stringify(answer.body)).not.toContain(CARD_SECRET);
  });

  test("a recorded framework error keeps its code", async ({ a2aServer }) => {
    const { url } = await a2aServer(listener);

    const answer = await rpc(url, "SendMessage", send("m-2", "recorded-framework"));

    expect(statusOf(answer)).toMatchObject({
      state: "TASK_STATE_FAILED",
      message: { parts: [{ text: "the task failed: step.agent" }] },
    });
  });
});
