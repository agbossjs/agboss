/**
 * #899 §5, §7 (AC3): files under PII policies — a transcription is masked by the policies' rules where
 * it is made and only the masked text is kept; a block rule refuses (an input file fails the execution,
 * a tool-result file rejects that call); the original goes through only where the policy lets files
 * through; PII never reads bytes; the cache never crosses policies, executions or tenants.
 */
import { PiiError } from "../../src/core/error-families/limit-errors.js";
import { MemorySaver } from "@langchain/langgraph";
import { afterEach, describe, expect, vi } from "vitest";
import { PiiFileAction, PiiKind, PiiPolicy, secret, type PiiRefusal } from "../../src/index.js";
import { FileTranscriber } from "../../src/files/file-transcriber.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText, tokensIn } from "../pii/boundary.helpers.js";
import {
  CSV_BYTES,
  FETCHABLE,
  FetchTool,
  inline,
  PNG_BYTES,
  readerApplication,
} from "./reader.factory.js";

const KEY = "FILES_PII_TEST_KEY";
const options = { processEnv: { [KEY]: "files-test-key" } } as never;

const CARD = "4242 4242 4242 4242";
const EMAIL = "bob@example.com";
const SSN = "078-05-1120";

@PiiPolicy({
  name: "contact-files-pii-policy",
  description: "Token for emails, kind for cards",
  rules: [PiiKind.Email.tokenize(), PiiKind.CardNumber.mask()],
  secret: secret(KEY),
})
class ContactFilesPolicy {}

@PiiPolicy({
  name: "ssn-files-pii-policy",
  description: "Refuses social security numbers",
  rules: [PiiKind.UsSsn.block()],
  secret: secret(KEY),
})
class SsnFilesPolicy implements PiiRefusal {
  refusal(kind: PiiKind): string {
    return `Please do not send a ${kind.id}.`;
  }
}

@PiiPolicy({
  name: "open-contact-files-pii-policy",
  description: "Token for emails; the original file may go through",
  rules: [PiiKind.Email.tokenize()],
  secret: secret(KEY),
  files: PiiFileAction.AllowOriginal,
})
class OpenContactFilesPolicy {}

const SCAN = `Invoice for ${EMAIL}, card ${CARD}`;

afterEach(() => {
  vi.restoreAllMocks();
  FETCHABLE.clear();
});

describe("AC3: a transcription reaches the model masked by the policy's rules", () => {
  const masked = readerApplication({
    files: ModelFiles.of({ views: [FileView.Transcription] }),
    piiPolicies: [ContactFilesPolicy],
  });

  testWith(masked.Application, options)(
    "AC3: tokens and kinds in the model's request, never the values; the agent's tool call reveals the token",
    async ({ app, mockModel }) => {
      mockModel(FileTranscriber).thenReturn(replyWith(SCAN));
      FETCHABLE.set(EMAIL, inline(PNG_BYTES, "image/png", "found.png"));
      let calls = 0;
      const agent = mockModel(masked.Agent).respondWith((request) => {
        calls += 1;
        const [token] = tokensIn(requestText(request), "email");
        return calls === 1 ? callTool(FetchTool, { name: token ?? "no token" }) : replyWith("done");
      });

      await execute(app, masked.Start, { document: inline(PNG_BYTES, "image/png", "inv.png") });

      const sent = agent.requests.map((request) => requestText(request)).join("\n");
      expect(sent).not.toContain(EMAIL);
      expect(sent).not.toContain(CARD);
      expect(sent).toContain("<card-number>");
      expect(tokensIn(sent, "email")).toHaveLength(1);
      // the token was revealed before the tool ran: it found the file by the real address
      expect(agent.requests).toHaveLength(2);
      expect(requestText(agent.requests[1] ?? agent.onlyRequest)).not.toContain("Tool error");
    },
  );

  testWith(masked.Application, options)(
    "AC3: the checkpoint keeps the masked transcription — the one-way value is in none of its writes",
    async ({ app, mockModel }) => {
      const puts = vi.spyOn(MemorySaver.prototype, "put");
      const writes = vi.spyOn(MemorySaver.prototype, "putWrites");
      mockModel(FileTranscriber).thenReturn(replyWith(SCAN));
      mockModel(masked.Agent).thenReturn(replyWith("ok"));

      await execute(app, masked.Start, { document: inline(PNG_BYTES, "image/png", "inv.png") });

      // every checkpoint and every pending write the saver was given
      const all = [...puts.mock.calls, ...writes.mock.calls]
        .map((args) => JSON.stringify(args[1]))
        .join("\n");
      expect(all).toContain("fileTranscripts");
      expect(all).toContain("<card-number>");
      expect(all).not.toContain(CARD);
    },
  );

  testWith(masked.Application, options)(
    "AC3: a text format is masked as text too: its own text goes through the policy",
    async ({ app, mockModel }) => {
      const agent = mockModel(masked.Agent).thenReturn(replyWith("ok"));
      const csv = Buffer.from(`who,card\nbob,${CARD}\n`);

      await execute(app, masked.Start, { document: inline(csv, "text/csv", "cards.csv") });

      const sent = requestText(agent.onlyRequest);
      expect(sent).not.toContain(CARD);
      expect(sent).toContain("bob,<card-number>");
    },
  );

  testWith(masked.Application, options)(
    "AC3: the transcription is made once for a file seen again; the checkpoint's cache serves it",
    async ({ app, mockModel }) => {
      const transcriber = mockModel(FileTranscriber).thenReturn(replyWith(SCAN));
      mockModel(masked.Agent).thenReturn(replyWith("ok"));

      await execute(app, masked.Start, { document: inline(PNG_BYTES, "image/png", "inv.png") });

      expect(transcriber.requests).toHaveLength(1);
    },
  );
});

describe("AC3: a block rule in a file refuses", () => {
  const blocking = readerApplication({
    files: ModelFiles.of({ views: [FileView.Transcription] }),
    piiPolicies: [SsnFilesPolicy],
  });
  const toolBlocking = readerApplication({
    files: ModelFiles.of({
      sources: [FileSource.ToolResults],
      views: [FileView.Transcription],
    }),
    piiPolicies: [SsnFilesPolicy],
  });

  testWith(blocking.Application, options)(
    "AC3: in an input file it fails the execution, as in the text; the agent's model is never called",
    async ({ app, mockModel }) => {
      mockModel(FileTranscriber).thenReturn(replyWith(`SSN ${SSN}`));
      const agent = mockModel(blocking.Agent);

      const run = execute(app, blocking.Start, {
        document: inline(PNG_BYTES, "image/png", "id.png"),
      });

      await expect(run).rejects.toFailWith(PiiError.Refused, { code: "pii.refused" });
      // the refusal itself leaves the run, not a wrapper of the file read around it (as for the text)
      await expect(run).rejects.toBeInstanceOf(PiiError.Refused);
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );

  testWith(toolBlocking.Application, options)(
    "AC3: in a tool-result file it rejects that call only: the model reads the refusal as the result",
    async ({ app, mockModel }) => {
      FETCHABLE.set("id", inline(PNG_BYTES, "image/png", "id.png"));
      mockModel(FileTranscriber).thenReturn(replyWith(`SSN ${SSN}`));
      const agent = mockModel(toolBlocking.Agent).thenReturn(
        callTool(FetchTool, { name: "id" }),
        replyWith("I could not read it"),
      );

      const result = await execute(app, toolBlocking.Start, {
        document: inline(CSV_BYTES, "text/csv", "items.csv"),
      });

      expect(result.output).toEqual({ text: "I could not read it" });
      const second = requestText(agent.requests[1] ?? agent.onlyRequest);
      expect(second).toContain("the call was refused: Please do not send a us-ssn.");
      expect(second).not.toContain(SSN);
    },
  );
});

describe("AC3: the original goes through only where every policy lets files through", () => {
  const open = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    piiPolicies: [OpenContactFilesPolicy],
  });

  testWith(open.Application, options)(
    "AC3: an image is a part untouched, a text format is still masked as text; PII never reads the bytes",
    async ({ app, mockModel }) => {
      const agent = mockModel(open.Agent).thenReturn(replyWith("ok"));
      const csv = Buffer.from(`who\n${EMAIL}\n`);

      await execute(app, open.Start, {
        document: inline(csv, "text/csv", "mail.csv"),
        pages: [inline(PNG_BYTES, "image/png", "page.png")],
      });

      const request = agent.onlyRequest;
      expect(request.kind === "chat" ? request.parts.map((part) => part.mediaType) : []).toEqual([
        "image/png",
      ]);
      const sent = requestText(request);
      expect(sent).not.toContain(EMAIL);
      expect(tokensIn(sent, "email")).toHaveLength(1);
    },
  );
});

describe("AC5: the cache never crosses executions or tenants", () => {
  const masked = readerApplication({
    files: ModelFiles.of({ views: [FileView.Transcription] }),
    piiPolicies: [ContactFilesPolicy],
  });

  testWith(masked.Application, options)(
    "AC5: the same file in another execution, or for another tenant, is transcribed again",
    async ({ app, mockModel }) => {
      const transcriber = mockModel(FileTranscriber).thenReturnAlways(replyWith(SCAN));
      mockModel(masked.Agent).thenReturnAlways(replyWith("ok"));
      const document = inline(PNG_BYTES, "image/png", "inv.png");

      await execute(app, masked.Start, { document }, { tenant: { tenantId: "acme" } });
      await execute(app, masked.Start, { document }, { tenant: { tenantId: "acme" } });
      await execute(app, masked.Start, { document }, { tenant: { tenantId: "globex" } });

      expect(transcriber.requests).toHaveLength(3);
    },
  );
});

@PiiPolicy({
  name: "names-files-pii-policy",
  description: "Finds names with a model; the original file may go through",
  rules: [PiiKind.PersonName.mask()],
  model: "local/reader",
  secret: secret(KEY),
  files: PiiFileAction.AllowOriginal,
})
class NamesFilesPolicy {}

describe("AC3: PII never reads bytes: a detection model is never sent a file part", () => {
  const detecting = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original] }),
    piiPolicies: [NamesFilesPolicy],
  });

  testWith(detecting.Application, options)(
    "AC3: the picture reaches the agent's model as a part; the detector reads the texts only",
    async ({ app, mockModel }) => {
      const detector = mockModel(NamesFilesPolicy).thenReturnAlways(replyWith('{"found":[]}'));
      const agent = mockModel(detecting.Agent).thenReturn(replyWith("ok"));

      await execute(app, detecting.Start, {
        document: inline(PNG_BYTES, "image/png", "page.png"),
      });

      expect(agent.onlyRequest.kind === "chat" ? agent.onlyRequest.parts : []).toHaveLength(1);
      expect(detector.requests.length).toBeGreaterThan(0);
      expect(JSON.stringify(detector.requests)).not.toContain(PNG_BYTES.toString("base64"));
      expect(
        detector.requests.every((request) => request.kind !== "chat" || request.parts.length === 0),
      ).toBe(true);
    },
  );
});

describe("AC3: a masked transcription is searched once", () => {
  const detecting = readerApplication({
    files: ModelFiles.of({ views: [FileView.Transcription] }),
    piiPolicies: [NamesFilesPolicy],
  });

  testWith(detecting.Application, options)(
    "AC3: the detection model reads the transcript where it is made; the model boundary does not search the masked text again",
    async ({ app, mockModel }) => {
      mockModel(FileTranscriber).thenReturn(replyWith("Dana Cohen signed here"));
      const detector = mockModel(NamesFilesPolicy).thenReturnAlways(
        replyWith('{"found":[{"kind":"person-name","text":"Dana Cohen"}]}'),
      );
      const agent = mockModel(detecting.Agent).thenReturn(replyWith("ok"));

      await execute(app, detecting.Start, {
        document: inline(PNG_BYTES, "image/png", "page.png"),
      });

      const readTranscript = detector.requests.filter((request) =>
        requestText(request).includes("signed here"),
      );
      expect(readTranscript).toHaveLength(1);
      expect(requestText(agent.onlyRequest)).not.toContain("Dana Cohen");
      expect(requestText(agent.onlyRequest)).toContain("<person-name> signed here");
    },
  );
});
