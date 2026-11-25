/**
 * #1316c: the inline cap (64 KB a file, 256 KB a payload) held at the entry points: a start's input
 * (`app.execute`), a tool's output; over it, a file is offloaded to the file store (owned by the root
 * execution) or, with no store listed, refused with `FileRefusal.InlineTooLarge`. The pause answer is
 * held by `recordedAnswer` (tests/app/inline-cap-answer-1316c.test.ts).
 */
import { createHash } from "node:crypto";
import { describe, expect } from "vitest";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import type { FileDto } from "../../src/dto/standard/file.js";
import { FileRefusal } from "../../src/files/file-errors.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { Injectable } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import { FETCHABLE, FetchTool, readerApplication } from "./reader.factory.js";

@Injectable({ deps: [IN_MEMORY_DATABASE] })
class KeptFiles extends InMemoryFileRepository {
  static last: KeptFiles | undefined;

  constructor(...args: ConstructorParameters<typeof InMemoryFileRepository>) {
    super(...args);
    KeptFiles.last = this;
  }
}

const textOf = (kilobytes: number, seed = "a"): Buffer =>
  Buffer.from(seed.repeat(kilobytes * 1024));

const inlineOf = (bytes: Buffer, name = "f.txt"): FileDto => ({
  mediaType: "text/plain",
  filename: name,
  inline: bytes.toString("base64"),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sizeBytes: bytes.byteLength,
});

const withStore = readerApplication({ providers: [KeptFiles] });
const noStore = readerApplication({ providers: [] });

const keptOf = async (file: FileDto, ownerId: string) => {
  const key = { tenantId: "default", fileId: `${ownerId}.${file.sha256 ?? ""}` };
  return KeptFiles.last?.findMetadata(key);
};

describe("app.execute: a start's input", () => {
  testWith(withStore.Application)(
    "a file over 64 KB is offloaded to the store under the run, its descriptor names it",
    async ({ app, mockModel }) => {
      mockModel(withStore.Agent).thenReturn(replyWith("ok"));
      const big = inlineOf(textOf(70));
      const input = { document: big };

      const out = await execute(app, withStore.Start, input);

      const kept = await keptOf(big, out.executionId);
      expect(kept?.ownerId).toBe(out.executionId);
      expect(
        await KeptFiles.last?.findBytes({ tenantId: "default", fileId: kept?.fileId ?? "" }),
      ).toEqual(new Uint8Array(textOf(70)));
    },
  );

  testWith(withStore.Application)("a file of 64 KB stays inline", async ({ app, mockModel }) => {
    mockModel(withStore.Agent).thenReturn(replyWith("ok"));
    const small = inlineOf(textOf(64));

    const out = await execute(app, withStore.Start, { document: small });

    expect(await keptOf(small, out.executionId)).toBeUndefined();
  });

  testWith(withStore.Application)(
    "files together over 256 KB: the largest leave until it fits",
    async ({ app, mockModel }) => {
      mockModel(withStore.Agent).thenReturn(replyWith("ok"));
      const input = {
        document: inlineOf(textOf(60, "a")),
        pages: [
          inlineOf(textOf(60, "b")),
          inlineOf(textOf(60, "c")),
          inlineOf(textOf(60, "d")),
          inlineOf(textOf(60, "e")),
        ],
      };

      const out = await execute(app, withStore.Start, input);

      const all = [input.document, ...input.pages];
      const kept = await Promise.all(all.map((file) => keptOf(file, out.executionId)));
      // 5 x 60 KB is 300 KB: one file leaves, the other four (240 KB) fit
      expect(kept.filter((meta) => meta !== undefined)).toHaveLength(1);
    },
  );

  testWith(noStore.Application)(
    "with no store a file over 64 KB is refused: FileError.Refused, InlineTooLarge, before the run",
    async ({ app }) => {
      const failure = await execute(app, noStore.Start, {
        document: inlineOf(textOf(70)),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FileError.Refused);
      expect(failure).toMatchObject({ refusal: FileRefusal.InlineTooLarge });
    },
  );

  testWith(noStore.Application)(
    "with no store a file under the caps still rides inline",
    async ({ app, mockModel }) => {
      mockModel(noStore.Agent).thenReturn(replyWith("ok"));

      const out = await execute(app, noStore.Start, { document: inlineOf(textOf(10)) });

      expect(out.executionId).toBeDefined();
    },
  );
});

describe("a tool's output", () => {
  testWith(withStore.Application)(
    "a file over 64 KB in a tool's result is offloaded under the root execution",
    async ({ app, mockModel }) => {
      const big = inlineOf(textOf(70, "t"), "tool.txt");
      FETCHABLE.set("big", big);
      mockModel(withStore.Agent).thenReturn(callTool(FetchTool, { name: "big" }), replyWith("ok"));

      const out = await execute(app, withStore.Start, { document: inlineOf(textOf(1)) });

      expect((await keptOf(big, out.executionId))?.ownerId).toBe(out.executionId);
    },
  );

  testWith(noStore.Application)(
    "with no store the call is a tool error the model reads, never the bytes",
    async ({ app, mockModel }) => {
      FETCHABLE.set("big2", inlineOf(textOf(70, "u"), "tool.txt"));
      const agent = mockModel(noStore.Agent).thenReturn(
        callTool(FetchTool, { name: "big2" }),
        replyWith("ok"),
      );

      await execute(app, noStore.Start, { document: inlineOf(textOf(1)) });

      const second = agent.requests[1];
      const text = requestText(second ?? agent.onlyRequest);
      expect(text).toContain("Tool error");
      expect(text).not.toContain("uuuuuuuu");
    },
  );
});
