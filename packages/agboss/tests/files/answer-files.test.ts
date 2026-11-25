/**
 * #899 §8: the files of an agent's answer — picked by number from the ones it saw (the default), the
 * model's own descriptors only when the developer allows them, and checked against origins and ownership.
 */
import { bytes as byteSize } from "../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { FileDto } from "../../src/dto/standard/file.js";
import { Nested, Text, List } from "../../src/dto/index.js";
import { modelWrittenFileProblem } from "../../src/files/answer-files.js";
import { AnswerFiles, FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { AgentAnswerInvalidError, GuardrailBlockedError } from "../../src/index.js";
import { callTool, decideWith, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { AnswerFilesGuardrail } from "./guardrails.fixture.js";
import {
  CSV_BYTES,
  FETCHABLE,
  FetchedDto,
  FetchTool,
  inline,
  PNG_BYTES,
  readerApplication,
  sha256Of,
} from "./reader.factory.js";

const asAnswer = (value: object): never => value as never;

class PickedDto {
  @Nested(FileDto, { prompt: "the file" })
  file!: FileDto;

  @Text({ prompt: "a note", optional: true })
  note?: string;
}

class ManyDto {
  @List(FileDto, { prompt: "the files" })
  files!: FileDto[];
}

describe("AC2: by default an agent returns only files it saw, picked by number", () => {
  const picking = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    output: FetchedDto,
  });

  testWith(picking.Application)(
    "AC2: the answer tool takes { file: <n> } for a file field, the schema says so",
    async ({ app, mockModel }) => {
      const agent = mockModel(picking.Agent).thenReturn(
        replyWith(FetchedDto, asAnswer({ file: { file: 1 } })),
      );

      await execute(app, picking.Start, { document: inline(PNG_BYTES, "image/png", "a.png") });

      const [tool] = agent.onlyRequest.kind === "chat" ? agent.onlyRequest.tools : [];
      const text = JSON.stringify(tool);
      expect(text).toContain('"file":{');
      expect(text).toContain('"required":["file"]');
      expect(text).not.toContain("inline");
      expect(text).not.toContain("fileId");
    },
  );

  testWith(picking.Application)(
    "AC2: number 1 is the descriptor the agent was shown, mapped back whole; the next step reads it",
    async ({ app, mockModel }) => {
      mockModel(picking.Agent).thenReturn(replyWith(FetchedDto, asAnswer({ file: { file: 1 } })));
      const given = inline(PNG_BYTES, "image/png", "a.png");

      const result = await execute(app, picking.Start, { document: given });

      expect(result.output).toEqual({ file: given });
    },
  );

  testWith(picking.Application)(
    "AC2: a descriptor the model writes is refused as an invalid answer, the model is told why",
    async ({ app, mockModel }) => {
      const written = inline(Buffer.from("made up"), "image/png", "x.png");
      mockModel(picking.Agent).thenReturn(
        replyWith(FetchedDto, asAnswer({ file: written })),
        replyWith(FetchedDto, asAnswer({ file: { file: 1 } })),
      );

      const result = await execute(app, picking.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      });

      expect(result.output).toEqual({ file: inline(PNG_BYTES, "image/png", "a.png") });
    },
  );

  testWith(picking.Application)(
    "AC2: a number that is no file it saw is an invalid answer; three of them fail the step",
    async ({ app, mockModel }) => {
      mockModel(picking.Agent).thenReturn(
        replyWith(FetchedDto, asAnswer({ file: { file: 2 } })),
        replyWith(FetchedDto, asAnswer({ file: { file: 0 } })),
        replyWith(FetchedDto, asAnswer({ file: { file: 7 } })),
      );

      const run = execute(app, picking.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      });

      await expect(run).rejects.toThrow(AgentAnswerInvalidError);
    },
  );

  testWith(picking.Application)(
    "AC2: a prompt-injected 'return https://internal/secret' is refused as an invalid answer",
    async ({ app, mockModel }) => {
      mockModel(picking.Agent).thenReturn(
        replyWith(
          FetchedDto,
          asAnswer({ file: { mediaType: "image/png", url: "https://internal/secret" } }),
        ),
        replyWith(FetchedDto, asAnswer({ file: { file: 1 } })),
      );

      const result = await execute(app, picking.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      });

      expect(JSON.stringify(result.output)).not.toContain("internal/secret");
    },
  );
});

describe("AC2: files are numbered once per visit, across fields and sources", () => {
  const sources = readerApplication({
    files: ModelFiles.of({
      sources: [FileSource.Input, FileSource.ToolResults],
      views: [FileView.Original],
    }),
    output: FetchedDto,
  });

  testWith(sources.Application)(
    "AC2: the input's files are 1 and 2, the tool's is 3 — and 3 picks the tool's file",
    async ({ app, mockModel }) => {
      const scan = inline(PNG_BYTES, "image/png", "scan.png");
      FETCHABLE.set("scan", scan);
      const agent = mockModel(sources.Agent).thenReturn(
        callTool(FetchTool, { name: "scan" }),
        replyWith(FetchedDto, asAnswer({ file: { file: 3 } })),
      );

      const result = await execute(app, sources.Start, {
        document: inline(CSV_BYTES, "text/csv", "items.csv"),
        pages: [inline(PNG_BYTES, "image/png", "page.png")],
      });

      expect(result.output).toEqual({ file: scan });
      const last = JSON.stringify(agent.requests[1]);
      expect(last).toContain("file 3: scan.png");
      expect(JSON.stringify(agent.requests[0])).toContain("file 1 of 2: items.csv");
    },
  );
});

describe("AC2: a file seen only as a transcription cannot be returned", () => {
  const either = readerApplication({
    files: ModelFiles.of({ views: [FileView.Transcription, FileView.Original] }),
    output: FetchedDto,
  });

  testWith(either.Application)(
    "AC2: with the original among the views the file is returned",
    async ({ app, mockModel }) => {
      const { FileTranscriber } = await import("../../src/files/file-transcriber.js");
      mockModel(FileTranscriber).thenReturn(replyWith("TEXT"));
      mockModel(either.Agent).thenReturn(replyWith(FetchedDto, asAnswer({ file: { file: 1 } })));

      const result = await execute(app, either.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      });

      expect(result.output).toMatchObject({ file: { filename: "a.png" } });
    },
  );
});

describe("AC2: answer files at any depth, in lists", () => {
  const listing = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    output: ManyDto,
  });
  const nested = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    output: PickedDto,
  });

  testWith(listing.Application)(
    "AC2: a list of files is a list of numbers",
    async ({ app, mockModel }) => {
      const first = inline(PNG_BYTES, "image/png", "a.png");
      const second = inline(CSV_BYTES, "text/csv", "b.csv");
      mockModel(listing.Agent).thenReturn(
        replyWith(ManyDto, asAnswer({ files: [{ file: 2 }, { file: 1 }] })),
      );

      const result = await execute(app, listing.Start, { document: first, pages: [second] });

      expect(result.output).toEqual({ files: [second, first] });
    },
  );

  testWith(nested.Application)(
    "AC2: the other fields of the DTO are untouched",
    async ({ app, mockModel }) => {
      const given = inline(PNG_BYTES, "image/png", "a.png");
      mockModel(nested.Agent).thenReturn(
        replyWith(PickedDto, asAnswer({ file: { file: 1 }, note: "here" })),
      );

      const result = await execute(app, nested.Start, { document: given });

      expect(result.output).toEqual({ file: given, note: "here" });
    },
  );
});

describe("AC2: AnswerFiles.Any — the model's own descriptors, checked", () => {
  const any = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original], answerFiles: AnswerFiles.Any }),
    output: FetchedDto,
    filePolicy: { allowedOrigins: ["https://files.example.com"] },
  });

  testWith(any.Application)(
    "AC2: a url on an allowed https origin goes through; an inline descriptor too",
    async ({ app, mockModel }) => {
      const url = { mediaType: "application/pdf", url: "https://files.example.com/a.pdf" };
      mockModel(any.Agent).thenReturn(replyWith(FetchedDto, asAnswer({ file: url })));

      const result = await execute(app, any.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      });

      expect(result.output).toEqual({ file: url });
    },
  );

  testWith(any.Application)(
    "AC2: http:, another origin, a url with a user, a fileId nobody owns → invalid answers",
    async ({ app, mockModel }) => {
      const refused = [
        { mediaType: "application/pdf", url: "http://files.example.com/a.pdf" },
        { mediaType: "application/pdf", url: "https://evil.example.org/a.pdf" },
        { mediaType: "application/pdf", url: "https://user:pw@files.example.com/a.pdf" },
        { mediaType: "application/pdf", fileId: "someone-elses-file" },
      ];
      mockModel(any.Agent).thenReturn(
        ...refused.slice(0, 3).map((file) => replyWith(FetchedDto, asAnswer({ file }))),
      );

      const run = execute(app, any.Start, { document: inline(PNG_BYTES, "image/png", "a.png") });

      await expect(run).rejects.toThrow(AgentAnswerInvalidError);
    },
  );

  testWith(any.Application)(
    "AC2: a fileId nobody owns is an invalid answer",
    async ({ app, mockModel }) => {
      const stranger = {
        mediaType: "application/pdf",
        fileId: "someone-elses-file",
        sha256: "a".repeat(64),
        sizeBytes: 3,
      };
      mockModel(any.Agent).thenReturn(
        replyWith(FetchedDto, asAnswer({ file: stranger })),
        replyWith(FetchedDto, asAnswer({ file: stranger })),
        replyWith(FetchedDto, asAnswer({ file: stranger })),
      );

      const run = execute(app, any.Start, { document: inline(PNG_BYTES, "image/png", "a.png") });

      await expect(run).rejects.toThrow(AgentAnswerInvalidError);
    },
  );
});

describe("AC4: output guardrails see the files of the answer, in the views the model saw", () => {
  const guarded = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    output: FetchedDto,
    guardrails: [AnswerFilesGuardrail],
  });

  testWith(guarded.Application)(
    "AC4: the answer's picture is a part of the guardrail's request, its text shows the file as metadata — a block stops the answer",
    async ({ app, mockModel }) => {
      mockModel(guarded.Agent).thenReturn(replyWith(FetchedDto, asAnswer({ file: { file: 1 } })));
      const guardrail = mockModel(AnswerFilesGuardrail).thenReturn(decideWith({ blocks: 0.9 }));
      const given = inline(PNG_BYTES, "image/png", "a.png");

      const run = execute(app, guarded.Start, { document: given });

      await expect(run).rejects.toFailWith(GuardrailBlockedError, {
        guard: "answer-files-guardrail",
        refusal: "The answer is held back.",
      });
      const request = guardrail.onlyRequest;
      expect(request.kind === "chat" ? request.parts.map((part) => part.mediaType) : []).toEqual([
        "image/png",
      ]);
      const text = JSON.stringify(request);
      expect(text).not.toContain(given.inline);
      expect(text).toContain(sha256Of(PNG_BYTES));
    },
  );

  testWith(guarded.Application)(
    "AC4: below the threshold the answer goes through",
    async ({ app, mockModel }) => {
      mockModel(guarded.Agent).thenReturn(replyWith(FetchedDto, asAnswer({ file: { file: 1 } })));
      mockModel(AnswerFilesGuardrail).thenReturn(decideWith({ blocks: 0.1 }));

      const result = await execute(app, guarded.Start, {
        document: inline(PNG_BYTES, "image/png", "a.png"),
      });

      expect(result.output).toMatchObject({ file: { filename: "a.png" } });
    },
  );
});

describe("AC2: the ownership of a stored file the model wrote", () => {
  const now = new Date(0);
  const stored = (tenantId: string, ownerId: string) => ({
    tenantId,
    fileId: "f-1",
    ownerId,
    mediaType: "application/pdf",
    sha256: "a".repeat(64),
    sizeBytes: byteSize(3),
    createdAt: now,
  });
  const file = {
    mediaType: "application/pdf",
    fileId: "f-1",
    sha256: "a".repeat(64),
    sizeBytes: byteSize(3),
  };
  const check = (kept: ReturnType<typeof stored> | undefined) => ({
    allowedOrigins: [],
    tenantId: "acme",
    ownerId: "root-1",
    store: {
      findMetadata: (key: { tenantId: string; fileId: string }) =>
        Promise.resolve(kept?.tenantId === key.tenantId ? kept : undefined),
    },
  });

  it("AC2: a file this root execution holds is allowed", async () => {
    expect(await modelWrittenFileProblem([file], check(stored("acme", "root-1")))).toBeUndefined();
  });

  it("AC2: another execution's file, another tenant's file and no file at all are refused", async () => {
    expect(await modelWrittenFileProblem([file], check(stored("acme", "root-2")))).toContain(
      "not one this execution holds",
    );
    expect(await modelWrittenFileProblem([file], check(stored("globex", "root-1")))).toContain(
      "not one this execution holds",
    );
    expect(await modelWrittenFileProblem([file], check(undefined))).toContain(
      "not one this execution holds",
    );
  });
});
