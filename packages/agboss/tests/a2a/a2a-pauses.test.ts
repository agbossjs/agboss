/**
 * #267 PR 2 over A2A: a paused response carries the ids of the pauses its caller may answer
 * (`pauseIds` — a `PauseAnswerer.Channel` pause's stays with its channel), and `resume` answers one
 * by its id, as the call's owner.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { A2AAdapter } from "../../src/a2a/index.js";
import { A2AStatus } from "../../src/a2a/types.js";
import { createApp } from "../../src/application/create-app.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  ConfirmOrderTool,
  DeskWorkflowStart,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "../channels/fixtures/pauses.workflow.js";

const offline = (book: ScriptBook) => ({ processEnv: {}, gateway: createScriptedGateway(book) });
const alice = { ownerId: "alice" };

beforeEach(resetPauses);

describe("#267: pauses over A2A", () => {
  it("a thread owner's pause: its id comes back, resume answers it as the owner", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:desk-clerk-agent")
      .thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }), replyWith("Confirmed."));
    const app = await createApp(PausesApplication, offline(book));
    const adapter = new A2AAdapter(app);

    const paused = await adapter.execute(
      DeskWorkflowStart,
      { input: { text: "confirm 7" } },
      undefined,
      alice,
    );
    const [pauseId] = paused.pauseIds ?? [];
    const done = await adapter.resume(
      { pauseId: pauseId ?? "", decision: { approved: true } },
      undefined,
      alice,
    );

    expect(paused).toMatchObject({
      status: A2AStatus.Paused,
      pauseIds: [seen.confirmations[0]?.pauseId],
    });
    expect(done).toMatchObject({ status: A2AStatus.Finished, output: { text: "Confirmed." } });
    expect(seen.confirmed).toEqual(["7"]);
    await app.close();
  });

  it("a channel's pause: no id comes back; an unknown id is a failed resume", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:desk-clerk-agent").thenReturn(callTool(RefundTool, { orderId: "7" }));
    const app = await createApp(PausesApplication, offline(book));
    const adapter = new A2AAdapter(app);

    const paused = await adapter.execute(DeskWorkflowStart, { input: { text: "refund 7" } });
    const unknown = await adapter.resume({
      pauseId: "no-such-pause",
      decision: { approved: true },
    });

    expect(paused).toMatchObject({ status: A2AStatus.Paused });
    expect(paused).not.toHaveProperty("pauseIds");
    expect(unknown).toMatchObject({ status: A2AStatus.Failed });
    await app.close();
  });
});
