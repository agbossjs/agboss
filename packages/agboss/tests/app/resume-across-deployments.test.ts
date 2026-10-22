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
import { logged, resetLogged } from "../helpers/log.js";
import { AGBossError, ApplicationStoppingError } from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import {
  holds,
  MailHold,
  MailParentStart,
  MailParentV1Application,
  MailParentV2Application,
  MailParentV2MigratingApplication,
} from "./fixtures/mail-child.workflow.js";

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
  resetLogged();
  holds.length = 0;
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

describe("#336 AC2: a child workflow's change makes its root incompatible", () => {
  /** Pauses a run inside the child on the first deployment, then builds `next` over the database. */
  async function pauseInChildThenDeploy(next: Class) {
    const book = scripted();
    const v1 = await createApp(MailParentV1Application, deploymentOf(book));
    const paused = await execute(v1, MailParentStart, { text: "Email the boss" });
    await v1.close();
    return { paused, next: await createApp(next, deploymentOf(book)) };
  }

  it("a child's prompt change makes the root incompatible: IncompatibleResumeError, nothing sent", async () => {
    const { paused, next } = await pauseInChildThenDeploy(MailParentV2Application);

    const resumed = next.resume(answerOf(paused, approve));

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending[0]?.childExecutionId).toBeDefined();
    await expect(resumed).rejects.toBeInstanceOf(IncompatibleResumeError);
    // the parent is the same 1.0.0: only its config hash, which covers the child, differs
    await expect(resumed).rejects.toMatchObject({
      code: "resume.incompatible",
      paused: { workflowVersion: "1.0.0" },
      current: { workflowVersion: "1.0.0" },
    });
    // an AGBossError with a static code (#336 Q5)
    await expect(resumed).rejects.toBeInstanceOf(AGBossError);
    expect(IncompatibleResumeError.code).toBe("resume.incompatible");
    expect(sent).toEqual([]);
    await next.close();
  });

  it("the same deployment restarted resumes inside the child without asking the policy", async () => {
    const { paused, next } = await pauseInChildThenDeploy(MailParentV1Application);

    const done = await next.resume(answerOf(paused, approve));

    expect(done.output).toEqual({ text: "Sent." });
    expect(sent).toEqual(["boss@example.com"]);
    expect(asked).toEqual([]);
    await next.close();
  });

  it("the policy resumes it: the paused child continues on the new deployment", async () => {
    const { paused, next } = await pauseInChildThenDeploy(MailParentV2MigratingApplication);

    const done = await next.resume(answerOf(paused, approve));

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(done.output).toEqual({ text: "Sent." });
    expect(sent).toEqual(["boss@example.com"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.paused.configHash).not.toBe(asked[0]?.current.configHash);
    await next.close();
  });

  it("recovery leaves a running root whose child changed to a compatible instance", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:mailer-agent")
      .thenReturn(callTool(MailHold, { text: "a moment" }), replyWith("Held."), replyWith("Held."));
    const v1 = await createApp(MailParentV1Application, deploymentOf(book));
    const running = execute(v1, MailParentStart, { text: "Wait" });
    await until(() => holds.length === 1);
    // the stop interrupts it inside the child: its record stays running
    await v1.close({ timeout: seconds(0) });
    await expect(running).rejects.toBeInstanceOf(ApplicationStoppingError);

    const v2 = await createApp(MailParentV2Application, deploymentOf(book));
    await until(() => logged.some((entry) => entry.code === "recovery.incompatible"));
    await v2.close();
    expect(holds).toHaveLength(1);

    const restarted = await createApp(MailParentV1Application, deploymentOf(book));
    await until(() => holds.length === 2);
    await restarted.close();
    expect(holds).toHaveLength(2);
  });
});

/** Until `condition` holds, a turn of the event loop at a time (a recovery runs in the background). */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 5000 && !condition(); turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}
