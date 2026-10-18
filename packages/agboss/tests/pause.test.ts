import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { TerminalUserChannel } from "../src/channels/terminal-channel.js";
import { DtoValidationError, Text } from "../src/dto/index.js";
import { NotPausedError, resumeAgent, Tool, type ToolHandler } from "../src/index.js";
import { ScriptedChatModel, type Reply } from "./fakes/scripted-model.js";
import { toolWorkflowOf } from "./fixtures/test-flow/star.workflow.js";
import { fakeDeps, memoryLedger, runText } from "./helpers.js";
import { ExecutionStatus } from "../src/app/types.js";

/** The emails the tool really sent (reset by `setup`). */
const sent: string[] = [];

class Email {
  @Text({ prompt: "the recipient" })
  to!: string;
}

class EmailSent {
  @Text()
  status!: string;
}

/** A write tool: the run pauses for an approval before it. */
@Tool({
  name: "send_email",
  description: "Send an email",
  channel: TerminalUserChannel,
  input: Email,
  output: EmailSent,
})
class SendEmail implements ToolHandler<Email, EmailSent> {
  run({ to }: Email): Promise<EmailSent> {
    sent.push(to);
    return Promise.resolve({ status: `sent to ${to}` });
  }
}

const callSend: Reply = [{ tool: "send_email", args: { to: "boss@example.com" } }];

const workflow = toolWorkflowOf({ tools: [SendEmail] });

async function setup(alphaReplies: readonly Reply[], withSeam = true) {
  sent.length = 0;
  const alpha = new ScriptedChatModel(alphaReplies);
  const ledger = memoryLedger();
  const base = await fakeDeps(
    {},
    {
      workflow,
      ledger,
      chatModel: (settings) =>
        settings.model === "test/alpha" ? alpha : new FakeListChatModel({ responses: [] }),
    },
  );
  const deps = withSeam ? base : { ...base, pause: undefined };
  return { deps, sent, alpha, ledger };
}

const task = "Email the boss";

describe("pause seam", () => {
  it("without a seam, write tools run as before", async () => {
    const { deps } = await setup([callSend, "Sent."], false);

    const result = await runText(task, deps);

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(sent).toEqual(["boss@example.com"]);
  });

  it("pauses before a write tool, with the pending call and nothing executed", async () => {
    const { deps, alpha } = await setup([callSend, "Sent."]);

    const paused = await runText(task, deps);

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pending: { agent: "alpha-agent", tool: "send_email", args: { to: "boss@example.com" } },
    });
    expect(sent).toEqual([]);
    expect(alpha.sent).toHaveLength(1);
    expect((await deps.terns.byIds([paused.ternId]))[0]?.status).toBe(ExecutionStatus.Paused);
  });

  it("resumes after approval: the tool runs once, same run and Tern", async () => {
    const { deps } = await setup([callSend, "Sent it to your boss."]);
    const paused = await runText(task, deps);

    const done = await resumeAgent(paused, { approved: true, by: "tester" }, deps);

    expect(done).toMatchObject({
      status: ExecutionStatus.Finished,
      output: { text: "Sent it to your boss." },
      runId: paused.runId,
      ternId: paused.ternId,
    });
    expect(sent).toEqual(["boss@example.com"]);
    expect((await deps.terns.byIds([paused.ternId]))[0]?.status).toBe("answered");
  });

  it("#141 AC5, #148 AC2: resumes with { approved, by, reason }; who rejected and why reach the agent", async () => {
    const { deps, alpha } = await setup([callSend, "Understood, not sending."]);
    const paused = await runText(task, deps);

    const done = await resumeAgent(
      paused,
      { approved: false, by: "tester", feedback: "not now" },
      deps,
    );

    expect(done.output).toEqual({ text: "Understood, not sending." });
    expect(sent).toEqual([]);
    expect(alpha.sent[1]?.at(-1)?.text).toBe(
      "Tool error: the call was rejected by tester: not now",
    );
  });

  it("#150 AC6: the turn that asked for the call is not asked again; the model continues after the decision", async () => {
    const { deps, alpha } = await setup([callSend, "Sent."]);
    const paused = await runText(task, deps);

    const done = await resumeAgent(paused, { approved: true, by: "tester" }, deps);

    expect(done).toMatchObject({ status: ExecutionStatus.Finished, output: { text: "Sent." } });
    expect(sent).toEqual(["boss@example.com"]);
    expect(alpha.sent).toHaveLength(2);
    expect(alpha.sent[1]?.at(-1)?.text).toBe('{"status":"sent to boss@example.com"}');
  });

  it("#148 AC2: reports a rejection without a reason plainly, naming who rejected", async () => {
    const { deps, alpha } = await setup([callSend, "Ok."]);
    const paused = await runText(task, deps);

    await resumeAgent(paused, { approved: false, by: "tester" }, deps);

    expect(alpha.sent[1]?.at(-1)?.text).toBe("Tool error: the call was rejected by tester");
  });

  it("keeps FinOps consistent: no spend recorded twice across pause and resume", async () => {
    const { deps, ledger } = await setup([callSend, "Done."]);
    const paused = await runText(task, deps);

    const done = await resumeAgent(paused, { approved: true, by: "tester" }, deps);

    expect(ledger.recorded).toHaveLength(done.cost.calls);
    expect(done.budgetUsd).toBe(paused.budgetUsd);
  });

  it("refuses to resume twice or to resume a finished run", async () => {
    const { deps } = await setup([callSend, "Done."]);
    const paused = await runText(task, deps);
    const done = await resumeAgent(paused, { approved: true, by: "tester" }, deps);

    await expect(
      resumeAgent(paused, { approved: true, by: "tester" }, deps),
    ).rejects.toBeInstanceOf(NotPausedError);
    await expect(resumeAgent(done, { approved: true, by: "tester" }, deps)).rejects.toBeInstanceOf(
      NotPausedError,
    );
  });

  it("records a failure after resume on the same Tern", async () => {
    const { deps: base } = await setup([callSend]);
    const paused = await runText(task, base);
    const deps = base;

    // alpha's script ends with the call: its next model call fails the resumed run
    await expect(resumeAgent(paused, { approved: true, by: "tester" }, deps)).rejects.toThrow();

    expect((await deps.terns.byIds([paused.ternId]))[0]).toMatchObject({ status: "failed" });
  });
});

describe("resume decisions", () => {
  it("#141 AC5: a decision without `by` (the old { approve } shape) is refused", async () => {
    const { deps } = await setup([callSend, "Sent."]);
    const paused = await runText(task, deps);
    const old: unknown = { approve: true };

    await expect(resumeAgent(paused, old, deps)).rejects.toBeInstanceOf(DtoValidationError);
    expect(sent).toEqual([]);
  });
});
