/**
 * #1269 (F1 of #899's review): the application's own `FileRedactor` and `FileTranscriber` are part of each
 * workflow's `configHash`, by class name — swapping one is another configuration, so a run paused under
 * one is not resumed blindly under the other (`IncompatibleResumeError`, #201). An application without one
 * keeps the hash it had.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import type { Class } from "../../src/components/injection.js";
import { FileRedactor } from "../../src/files/file-redactor.js";
import { FileTranscriber } from "../../src/files/file-transcriber.js";
import {
  EmptyEnvironment,
  IncompatibleResumeError,
  Injectable,
  type FileContent,
  type RedactionResult,
  type TranscriptionResult,
} from "../../src/index.js";
import { configSnapshot } from "../../src/run/versions.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { versionOf } from "../../src/turns/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { answerOf, execute } from "../helpers/flow.js";
import {
  resetSharedDatabase,
  SharedCheckpointSaver,
  SharedExecutionRecordRepository,
  SharedPausedExecutionRepository,
} from "../helpers/shared-infrastructure.js";
import { MailV1, SendEmail, sent, Start } from "../app/fixtures/mail.workflow.js";

@Injectable()
class PresidioImageRedactor extends FileRedactor {
  supports(): boolean {
    return true;
  }
  redact(file: FileContent): Promise<RedactionResult> {
    return Promise.resolve({ file, found: [] });
  }
}

@Injectable()
class BlackBoxRedactor extends FileRedactor {
  supports(): boolean {
    return true;
  }
  redact(file: FileContent): Promise<RedactionResult> {
    return Promise.resolve({ file, found: [] });
  }
}

@Injectable()
class OcrTranscriber extends FileTranscriber {
  transcribe(): Promise<TranscriptionResult> {
    return Promise.resolve({ text: "ocr" });
  }
}

@Injectable()
class WhisperTranscriber extends FileTranscriber {
  transcribe(): Promise<TranscriptionResult> {
    return Promise.resolve({ text: "whisper" });
  }
}

const durable = [
  SharedCheckpointSaver,
  SharedPausedExecutionRepository,
  SharedExecutionRecordRepository,
];

/** One deployment of the mail workflow: the same name, version and flow, the file processors it lists. */
function deployment(processors: readonly Class[]): Class {
  @Application({
    name: "mail-v1-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [MailV1],
    providers: [...durable, ...processors],
    budgets: TEST_BUDGETS,
  })
  class MailDeploymentApplication {}
  return MailDeploymentApplication;
}

const hashOf = async (processors: readonly Class[]): Promise<string> => {
  const [workflow] = (await applicationOf(deployment(processors))).workflows;
  if (workflow === undefined) throw new TypeError("no workflow");
  return versionOf(configSnapshot(workflow));
};

describe("#1269 F1: the application's own file processors are in configHash", () => {
  it("without one the snapshot has no fileProcessors key: the hash is the one it was", async () => {
    const [workflow] = (await applicationOf(deployment([]))).workflows;

    expect(configSnapshot(workflow as never)).not.toHaveProperty("fileProcessors");
  });

  it("a redactor is named; another redactor is another hash, and so is none", async () => {
    const [workflow] = (await applicationOf(deployment([PresidioImageRedactor]))).workflows;

    expect(configSnapshot(workflow as never)).toMatchObject({
      fileProcessors: { redactor: "PresidioImageRedactor" },
    });
    expect(configSnapshot(workflow as never)).not.toHaveProperty("fileProcessors.transcriber");
    const hashes = await Promise.all([
      hashOf([]),
      hashOf([PresidioImageRedactor]),
      hashOf([BlackBoxRedactor]),
    ]);
    expect(new Set(hashes).size).toBe(3);
  });

  it("a transcriber is named; another transcriber is another hash, and so is none", async () => {
    const [workflow] = (await applicationOf(deployment([OcrTranscriber]))).workflows;

    expect(configSnapshot(workflow as never)).toMatchObject({
      fileProcessors: { transcriber: "OcrTranscriber" },
    });
    expect(configSnapshot(workflow as never)).not.toHaveProperty("fileProcessors.redactor");
    const hashes = await Promise.all([
      hashOf([]),
      hashOf([OcrTranscriber]),
      hashOf([WhisperTranscriber]),
      hashOf([OcrTranscriber, PresidioImageRedactor]),
    ]);
    expect(new Set(hashes).size).toBe(4);
  });
});

function scripted(): ScriptBook {
  const book = new ScriptBook();
  book
    .scriptOf("agent:mailer-agent")
    .thenReturn(callTool(SendEmail, { to: "boss@example.com" }), replyWith("Sent."));
  return book;
}

/** Pauses a run on a deployment with `before`, then resumes it on one with `after`, over one database. */
async function resumedAcross(before: readonly Class[], after: readonly Class[]) {
  const book = scripted();
  const options = () => ({ processEnv: {}, gateway: createScriptedGateway(book) });
  const first = await createTestAppWith(deployment(before), options());
  const paused = await execute(first, Start, { text: "Email the boss" });
  await first.close();
  const next = await createTestAppWith(deployment(after), options());
  try {
    return await next.resume(answerOf(paused, { approved: true }));
  } finally {
    await next.close();
  }
}

beforeEach(() => {
  resetSharedDatabase();
  sent.length = 0;
});

describe("#1269 F1: a run paused under one file processor is not resumed blindly under another", () => {
  it("another redactor: IncompatibleResumeError, nothing sent", async () => {
    const resumed = resumedAcross([PresidioImageRedactor], [BlackBoxRedactor]);

    await expect(resumed).rejects.toBeInstanceOf(IncompatibleResumeError);
    expect(sent).toEqual([]);
  });

  it("another transcriber: IncompatibleResumeError, nothing sent", async () => {
    const resumed = resumedAcross([OcrTranscriber], [WhisperTranscriber]);

    await expect(resumed).rejects.toBeInstanceOf(IncompatibleResumeError);
    expect(sent).toEqual([]);
  });

  it("a redactor dropped: IncompatibleResumeError", async () => {
    await expect(resumedAcross([PresidioImageRedactor], [])).rejects.toBeInstanceOf(
      IncompatibleResumeError,
    );
  });

  it("the same processors resume and finish", async () => {
    const done = await resumedAcross(
      [PresidioImageRedactor, OcrTranscriber],
      [PresidioImageRedactor, OcrTranscriber],
    );

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(sent).toEqual(["boss@example.com"]);
  });
});
