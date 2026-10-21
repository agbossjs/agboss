import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import type { Class } from "../../src/components/injection.js";
import { IncompatibleResumeError, UnknownPauseError } from "../../src/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  asked,
  MailV1Application,
  MailV1MemoryPausesApplication,
  MailV2Application,
  MailV2MigratingApplication,
  observed,
  SendEmail,
  sent,
  Start,
} from "./fixtures/mail.workflow.js";
import { execute, answerOf } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { resetSharedDatabase, sharedPausedRun } from "../helpers/shared-infrastructure.js";

const approve = { approved: true };

/** One deployment: scripted models; its infrastructure is the shared database it lists. */
const deploymentOf = (book: ScriptBook) => ({
  processEnv: {},
  gateway: createScriptedGateway(book),
});

function scripted(): ScriptBook {
  const book = new ScriptBook();
  book
    .scriptOf("agent:mailer-agent")
    .thenReturn(callTool(SendEmail, { to: "boss@example.com" }), replyWith("Sent."));
  return book;
}

/** Pauses a run on the first deployment, then builds `next` over the same database. */
async function pauseThenDeploy(next: Class) {
  const book = scripted();
  const v1 = await createApp(MailV1Application, deploymentOf(book));
  const paused = await execute(v1, Start, { text: "Email the boss" });
  await v1.close();
  return { paused, next: await createApp(next, deploymentOf(book)), book };
}

beforeEach(() => {
  resetSharedDatabase();
  sent.length = 0;
  asked.length = 0;
  observed.length = 0;
});

describe("#201 AC1: a run paused under another workflow version is not resumed blindly", () => {
  it("resuming on a deployment with another config hash fails with IncompatibleResumeError naming both versions", async () => {
    const { paused, next } = await pauseThenDeploy(MailV2Application);

    const resumed = next.resume(answerOf(paused, approve));

    expect(paused.status).toBe(ExecutionStatus.Paused);
    await expect(resumed).rejects.toBeInstanceOf(IncompatibleResumeError);
    await expect(resumed).rejects.toMatchObject({
      code: "resume.incompatible",
      threadId: paused.threadId,
      paused: { workflowVersion: "1.0.0" },
      current: { workflowVersion: "2.0.0" },
    });
    await expect(resumed).rejects.toThrow(/paused under 1\.0\.0 .* this app runs 2\.0\.0/);
    expect(sent).toEqual([]);
  });

  it("a rejected resume leaves the run paused: a deployment that accepts it continues it", async () => {
    const { paused, next, book } = await pauseThenDeploy(MailV2Application);
    await expect(next.resume(answerOf(paused, approve))).rejects.toThrow(IncompatibleResumeError);
    await next.close();

    const migrating = await createApp(MailV2MigratingApplication, deploymentOf(book));
    const done = await migrating.resume(answerOf(paused, approve));

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(done.output).toEqual({ text: "Sent." });
    expect(sent).toEqual(["boss@example.com"]);
  });

  it("with onIncompatibleResume returning 'resume' the run continues on the new graph", async () => {
    const { paused, next } = await pauseThenDeploy(MailV2MigratingApplication);

    const done = await next.resume(answerOf(paused, approve));

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(done.output).toEqual({ text: "Sent." });
    expect(sent).toEqual(["boss@example.com"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      threadId: paused.threadId,
      paused: { workflowVersion: "1.0.0" },
      current: { workflowVersion: "2.0.0" },
    });
    expect(asked[0]?.paused.configHash).not.toBe(asked[0]?.current.configHash);
  });

  it("the same deployment restarted resumes without asking the policy", async () => {
    const { paused, next } = await pauseThenDeploy(MailV1Application);

    const done = await next.resume(answerOf(paused, approve));

    expect(done.output).toEqual({ text: "Sent." });
    expect(asked).toEqual([]);
  });
});

describe("#201 AC2: paused runs survive an app restart with durable stores", () => {
  /** A restart: the app instance goes, the database it lists stays. */
  async function restartOn(application: Class) {
    const book = scripted();
    const app = await createApp(application, deploymentOf(book));
    const paused = await execute(app, Start, { text: "Email the boss" });
    await app.close();
    return { paused, restarted: await createApp(application, deploymentOf(book)) };
  }

  it("a run paused before the restart is resumed by the new instance from the durable repository", async () => {
    const { paused, restarted } = await restartOn(MailV1Application);
    const record = sharedPausedRun(paused.threadId);

    const done = await restarted.resume(answerOf(paused, approve));

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(record).toMatchObject({
      workflowVersion: "1.0.0",
      run: { status: ExecutionStatus.Paused, budgetUsd: 100 }, // the test execution budget
    });
    expect(sharedPausedRun(paused.threadId)).toBeUndefined();
    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(done.output).toEqual({ text: "Sent." });
    expect(sent).toEqual(["boss@example.com"]);
  });

  it("with the built-in in-memory repository the restarted app does not know the paused run", async () => {
    const { paused, restarted } = await restartOn(MailV1MemoryPausesApplication);

    await expect(restarted.resume(answerOf(paused, approve))).rejects.toBeInstanceOf(
      UnknownPauseError,
    );
  });
});

describe("#246 AC3: an incompatible resume is the paused run's onError; the run stays paused", () => {
  it("onError(IncompatibleResumeError) with the paused run's id and thread, then a policy resumes it", async () => {
    const { paused, next, book } = await pauseThenDeploy(MailV2Application);
    observed.length = 0;

    const refused = next.resume(answerOf(paused, approve));

    await expect(refused).rejects.toBeInstanceOf(IncompatibleResumeError);
    expect(observed).toEqual([
      {
        hook: "error",
        state: { runId: paused.executionId, threadId: paused.threadId },
        detail: await refused.catch((error: unknown) => error),
      },
    ]);
    await next.close();

    const migrating = await createApp(MailV2MigratingApplication, deploymentOf(book));
    const done = await migrating.resume(answerOf(paused, approve));

    expect(done).toMatchObject({
      status: ExecutionStatus.Finished,
      executionId: paused.executionId,
      threadId: paused.threadId,
    });
    expect(sent).toEqual(["boss@example.com"]);
    expect(observed.map((event) => event.hook)).toEqual(["error"]);
  });
});
