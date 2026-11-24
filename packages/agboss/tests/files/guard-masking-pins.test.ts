/**
 * #899 §3, §5, §8 (AC3, AC4): the corners of the guards on files that a sabotage run found open — a PDF's
 * name and the output guardrails' and judges' views are masked as the agent's model reads them, a judge reads
 * a file pinned to what the agent saw, an answer file is picked only from the original views, and a descriptor
 * the model wrote is held to https, an allowed origin and no user.
 */
import { NO_REDACTION } from "./runtime-parts.js";
import { describe, expect, it } from "vitest";
import {
  modelWrittenFileProblem,
  pickingMapper,
  seenPicker,
} from "../../src/files/answer-files.js";
import { sha256Of } from "../../src/files/file-bytes.js";
import { ModelFileUnavailableReason } from "../../src/files/file-errors.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileTranscriber } from "../../src/files/file-transcriber.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import type { FileRuntime } from "../../src/files/visit-files.js";
import { judgedFilesOf } from "../../src/graph/agent-loop/judge-files.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { PiiFileAction, PiiKind, PiiPolicy } from "../../src/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { decideWith, replyWith, testWith } from "../../src/testing/index.js";
import { kilobytes, seconds } from "../../src/units/index.js";
import { PNG, scriptedTransport } from "../a2a/files/support.js";
import { execute } from "../helpers/flow.js";
import { AnswerFilesGuardrail, GroundedJudge, IgnoreRulesGuardrail } from "./guardrails.fixture.js";
import {
  CSV_BYTES,
  FetchedDto,
  inline,
  PDF_BYTES,
  PNG_BYTES,
  readerApplication,
} from "./reader.factory.js";

const EMAIL = "bob@example.com";

@PiiPolicy({
  name: "pins-mail-pii-policy",
  description: "Hides emails; the original file may go through",
  rules: [PiiKind.Email.mask()],
  files: PiiFileAction.AllowOriginal,
})
class MailPolicy {}

const asAnswer = (value: object): never => value as never;

describe("AC4: a PDF's name is personal data too — a guardrail's model reads it masked", () => {
  const named = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    guardrails: [IgnoreRulesGuardrail],
    piiPolicies: [MailPolicy],
  });

  testWith(named.Application)(
    "AC4: the file part of the guardrail's request carries the token, not the address",
    async ({ app, mockLlm }) => {
      mockLlm(named.Agent).thenReturn(replyWith("ok"));
      const guardrail = mockLlm(IgnoreRulesGuardrail).thenReturnAlways(
        decideWith({ blocks: 0.01 }),
      );

      await execute(app, named.Start, {
        document: inline(PDF_BYTES, "application/pdf", `${EMAIL}.pdf`),
      });

      const parts = guardrail.requests.flatMap((request) =>
        request.kind === "chat" ? request.parts : [],
      );
      expect(parts.some((part) => part.mediaType === "application/pdf")).toBe(true);
      expect(JSON.stringify(guardrail.requests)).not.toContain(EMAIL);
    },
  );
});

describe("AC4: the output guardrails and the judges read the files as the agent's model does — masked", () => {
  const guarded = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    output: FetchedDto,
    guardrails: [AnswerFilesGuardrail],
    piiPolicies: [MailPolicy],
  });
  const judged = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    judges: [GroundedJudge],
    piiPolicies: [MailPolicy],
  });

  testWith(guarded.Application)(
    "AC4: an answer file named after an address reaches an output guardrail's model as the token",
    async ({ app, mockLlm }) => {
      mockLlm(guarded.Agent).thenReturn(replyWith(FetchedDto, asAnswer({ file: { file: 1 } })));
      const guardrail = mockLlm(AnswerFilesGuardrail).thenReturn(decideWith({ blocks: 0.1 }));

      await execute(app, guarded.Start, {
        document: inline(CSV_BYTES, "text/csv", `${EMAIL}.csv`),
      });

      expect(JSON.stringify(guardrail.onlyRequest)).not.toContain(EMAIL);
      expect(JSON.stringify(guardrail.onlyRequest)).toContain("<email>");
    },
  );

  const transcribed = readerApplication({
    files: ModelFiles.of({ views: [FileView.Transcription] }),
    judges: [GroundedJudge],
    piiPolicies: [MailPolicy],
  });

  testWith(transcribed.Application)(
    "AC4: a judge reads the masked transcription the agent read: made once, never again raw",
    async ({ app, mockLlm }) => {
      const transcriber = mockLlm(FileTranscriber).thenReturnAlways(replyWith(`mail ${EMAIL}`));
      mockLlm(transcribed.Agent).thenReturn(replyWith("ok"));
      const judge = mockLlm(GroundedJudge).thenReturn(replyWith("yes"));

      await execute(app, transcribed.Start, {
        document: inline(PNG_BYTES, "image/png", "scan.png"),
      });

      expect(transcriber.requests).toHaveLength(1);
      expect(JSON.stringify(judge.onlyRequest)).not.toContain(EMAIL);
      expect(JSON.stringify(judge.onlyRequest)).toContain("<email>");
    },
  );

  testWith(judged.Application)(
    "AC4: a judge's model reads a file's text masked, never the address in it",
    async ({ app, mockLlm }) => {
      mockLlm(judged.Agent).thenReturn(replyWith("ok"));
      const judge = mockLlm(GroundedJudge).thenReturn(replyWith("yes"));

      await execute(app, judged.Start, {
        document: inline(Buffer.from(`who\n${EMAIL}\n`), "text/csv", "mail.csv"),
      });

      expect(JSON.stringify(judge.onlyRequest)).not.toContain(EMAIL);
      expect(JSON.stringify(judge.onlyRequest)).toContain("<email>");
    },
  );
});

const URL_OF = "https://files.example/a.png";

const runtimeOn = (served: Record<string, { body: Uint8Array }>): FileRuntime => {
  const script = scriptedTransport(served);
  return {
    agent: "a-agent",
    settings: resolvedFilesOf({
      agent: ModelFiles.of({ views: [FileView.Original] }).options,
      defaults: undefined,
      skills: [],
      a2aFiles: undefined,
      hasPiiPolicy: false,
    }),
    maxResultSize: kilobytes(8),
    ...NO_REDACTION,
    transcriberKey: () => "t",
    transcribe: () => Promise.reject(new Error("none")),
    context: () => ({
      store: new InMemoryA2AFileRepository(new InMemoryDatabase()),
      tenantId: "acme",
      ownerId: "root-1",
      signal: new AbortController().signal,
      clock: new VirtualClock(),
      transport: script.transport,
      allowedOrigins: ["https://files.example"],
      fetchTimeout: seconds(5),
      maxFileSize: kilobytes(8),
    }),
  };
};

const judgedOn = (runtime: FileRuntime) =>
  judgedFilesOf(
    {
      seen: [
        {
          source: {
            descriptor: { mediaType: "image/png", url: URL_OF },
            field: "f",
            producer: "p",
          },
          digest: sha256Of(PNG),
        },
      ],
      fileTranscripts: {},
      piiTokens: {},
      usage: [],
      flowPath: [],
    } as never,
    { fileRuntime: runtime, budgets: { check: () => undefined } } as never,
  );

describe("AC4: a judge reads a file pinned to the digest the agent saw", () => {
  it("unchanged: the judge gets the file", async () => {
    const judged = await judgedOn(runtimeOn({ [URL_OF]: { body: PNG } }));

    expect(judged.files).toHaveLength(1);
  });

  it("changed after the agent's read: digest-mismatch, the judge never sees the new bytes", async () => {
    const run = judgedOn(runtimeOn({ [URL_OF]: { body: Buffer.concat([PNG, Buffer.from("x")]) } }));

    await expect(run).rejects.toMatchObject({ reason: ModelFileUnavailableReason.DigestMismatch });
  });
});

describe("AC2: an answer file is picked only by its number and only from original views", () => {
  const seen = [
    {
      source: { descriptor: { mediaType: "image/png", url: URL_OF }, field: "f", producer: "p" },
      digest: sha256Of(PNG),
    },
  ];

  it("a file seen only as a transcription cannot be picked", () => {
    const picked = seenPicker(seen, false).pick(1);

    expect(picked).toMatchObject({ kind: "problem" });
  });

  it("a descriptor without a digest is handed on with the digest of the bytes it was read as", () => {
    const picked = seenPicker(seen, true).pick(1);

    expect(picked.kind === "file" ? picked.file.sha256 : undefined).toBe(sha256Of(PNG));
  });

  it("anything but { file: <n> } is refused: no other key rides along", () => {
    const map = pickingMapper(seenPicker(seen, true));

    expect(() => map({ file: 1, url: "https://evil.example/x" })).toThrow("a file in the answer");
    expect(() => map({ url: "https://evil.example/x" })).toThrow("a file in the answer");
    expect(() => map({ file: 0 })).toThrow("a file in the answer");
    expect(map({ file: 1 })).toMatchObject({ url: URL_OF });
  });
});

describe("AC2: a descriptor the model wrote is held to https, an allowed origin and no user", () => {
  const check = {
    allowedOrigins: ["https://files.example.com", "http://plain.example.com"],
    tenantId: "acme",
    ownerId: "root-1",
    store: { findMetadata: () => Promise.resolve(undefined) },
  };
  const urlFile = (url: string) => ({ mediaType: "application/pdf", url });

  it("https on an allowed origin goes through", async () => {
    expect(
      await modelWrittenFileProblem([urlFile("https://files.example.com/a.pdf")], check),
    ).toBeUndefined();
  });

  it("http is refused even on a listed origin; so are another origin and a user", async () => {
    expect(
      await modelWrittenFileProblem([urlFile("http://plain.example.com/a.pdf")], check),
    ).toContain("not https:");
    expect(
      await modelWrittenFileProblem([urlFile("https://evil.example.org/a.pdf")], check),
    ).toContain("not allowed");
    expect(
      await modelWrittenFileProblem([urlFile("https://u:p@files.example.com/a.pdf")], check),
    ).toContain("user or a password");
    expect(await modelWrittenFileProblem([urlFile("not a url")], check)).toContain("not a URL");
  });
});

describe("AC2: the problem of a descriptor the model wrote names its place, never what it wrote", () => {
  it("a planted file name and url origin are in no message", async () => {
    const check = {
      allowedOrigins: ["https://files.example.com"],
      tenantId: "acme",
      ownerId: "root-1",
      store: { findMetadata: () => Promise.resolve(undefined) },
    };
    const secret = "dana.cohen@example.com";
    const problems = await Promise.all([
      modelWrittenFileProblem(
        [{ mediaType: "application/pdf", filename: secret, url: "https://dana-cohen.evil.org/a" }],
        check,
      ),
      modelWrittenFileProblem(
        [{ mediaType: "application/pdf", filename: secret, fileId: "f-1" }],
        check,
      ),
    ]);

    for (const problem of problems) {
      expect(problem).toContain("answer file 1 of 1");
      expect(problem).not.toContain("dana");
    }
  });
});
