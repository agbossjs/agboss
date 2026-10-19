/**
 * #183 AC1: one `deps` contract for every component kind — each kind that takes `deps` gets its
 * dependency injected by the app's container (through `createApp`), not `undefined`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { JudgeVerdict } from "../../src/components/judge-decorators.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { toolResultsOf } from "../testing/fixtures/requests.js";
import {
  MaskSecret,
  RemoteAgent,
  RevealTool,
  seen,
  StrictJudge,
  Vault,
  VaultChannel,
} from "./fixture/deps-contract.components.js";
import { Chat, KeptDto, offline, VaultApplication } from "./fixture/deps-contract.workflow.js";
import { execute } from "../helpers/flow.js";

const runVault = async () => {
  const book = new ScriptBook();
  book
    .scriptOf("agent:keeper-agent")
    .thenReturn(callTool(RevealTool, { what: "it" }), replyWith(KeptDto, { text: "ok" }));
  const app = await createApp(VaultApplication, offline(book));
  const result = await execute(app, Chat, { text: "open" });
  return { app, book, result };
};

describe("#183 AC1: every decorator kind with deps gets them injected at run time", () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it("@Tool / @Injectable: the tool's result carries the injected chain Vault ← SECRET", async () => {
    const { app, book } = await runVault();
    // the tool returned the secret it was injected; the workflow's MaskSecret policy closes it (#120)
    expect(toolResultsOf(book.scriptOf("agent:keeper-agent").lastRequest)).toEqual([
      '{"text":"<mask-secret>"}',
    ]);
    await app.close();
  });

  it("@Guardrail, @Rag, @WorkflowAction: each ran with its dependency during the run", async () => {
    const { app, result } = await runVault();
    expect(result.finish).toEqual({ name: "kept-workflow-finish" });
    expect(seen).toContain("guardrail:s3cret");
    expect(seen).toContain("rag:s3cret");
    expect(seen).toContain("action:s3cret");
    await app.close();
  });

  it("@PiiPolicy: the policy the app created finds with its injected secret", async () => {
    const { app } = await runVault();
    expect(app.resolve(MaskSecret).findMatches("the s3cret word")).toEqual([{ start: 4, end: 10 }]);
    await app.close();
  });

  it("@Channel: created with deps", async () => {
    const { app } = await runVault();
    await expect(app.resolve(VaultChannel).send({ pauseId: "p1", value: {} })).resolves.toEqual(
      ChannelOutcome.awaitReply(),
    );
    expect(seen).toContain("channel:p1:s3cret");
    await app.close();
  });

  it("@Judge and @A2AAgent: the container creates them with their deps", async () => {
    const { app } = await runVault();
    const judge = app.resolve(StrictJudge);
    await expect(
      judge.judge({ reply: { text: "leaks s3cret" }, task: "", attempt: 0 }),
    ).resolves.toEqual(JudgeVerdict.failed({ reason: "leaks the secret" }));
    expect(app.resolve(RemoteAgent).vault).toBe(app.resolve(Vault));
    expect(app.resolve(Vault).secret).toBe("s3cret");
    await app.close();
  });
});
