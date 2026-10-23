import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { withInboundMesh, type InboundMesh } from "../../src/mesh/inbound-mesh.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  ConfirmOrderTool,
  DeskWorkflowStart,
  PausesApplication,
  resetPauses,
  seen,
} from "../channels/fixtures/pauses.workflow.js";

beforeEach(resetPauses);

const origin = {
  application: "orders-application",
  rootExecutionId: "root-1",
  executionId: "root-1",
  workflow: { name: "orders-workflow", version: "1.0.0" },
  step: { component: "orders-desk-agent", idempotencyKey: "root-1:orders-desk-agent:1:c1" },
  hops: 1,
};

/** What a listener hands the execution of a trusted peer's request. */
const trusted: InboundMesh = {
  chain: [
    { application: "orders-application", start: "orders-workflow-start", executionId: "root-1" },
  ],
  trusted: { origin },
};

describe("#398 PR 2b: a trusted request's origin on its resume legs", () => {
  it("onExecutionResume of a resumed execution carries the origin its first leg had", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:desk-clerk-agent")
      .thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }), replyWith("Confirmed."));
    const app = await createApp(PausesApplication, {
      processEnv: {},
      gateway: createScriptedGateway(book),
    });
    const owner = { ownerId: "alice" };

    const paused = await execute(
      app,
      DeskWorkflowStart,
      { text: "confirm 7" },
      withInboundMesh(owner, trusted),
    );
    const done = await app.resume(answerOf(paused, { approved: true }), owner);
    await app.close();

    expect(done).toMatchObject({ output: { text: "Confirmed." } });
    expect(seen.pauses[0]?.origin).toEqual(origin);
    expect(seen.resumes[0]?.origin).toEqual(origin);
  });

  it("an untrusted execution's resume carries none", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:desk-clerk-agent")
      .thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }), replyWith("Confirmed."));
    const app = await createApp(PausesApplication, {
      processEnv: {},
      gateway: createScriptedGateway(book),
    });
    const owner = { ownerId: "alice" };

    const paused = await execute(app, DeskWorkflowStart, { text: "confirm 7" }, owner);
    await app.resume(answerOf(paused, { approved: true }), owner);
    await app.close();

    expect(seen.resumes[0]).toBeDefined();
    expect(seen.resumes[0]?.origin).toBeUndefined();
  });
});
